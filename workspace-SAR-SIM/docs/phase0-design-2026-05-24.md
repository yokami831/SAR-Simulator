# Phase0 設計書 — バイナリ単一レンダラー 3D表示 第2経路（基盤整備）

対象セッション: dev-image-target-improve (2026-05-24)
親引き継ぎ書: `image-target-handoff-2026-05-24.md` §9（設計確定済み）

## Phase0 のゴール

新表示経路の**配管だけ**を通す。実際の表示移行(n18等を_glに)は Phase1。Phase0完了の定義 =
「`surface3d_gl` を呼ぶと新mimeでemitされ、フロントの新 `Surface3D` コンポーネントが
**単一WebGLレンダラー**で1枚描画でき、three読込/WebGL失敗時は**赤エラーを明示**（旧iframeに黙って落ちない）」。

ビルドが通り、Electron再起動後に最小1枚が描画されるところまで。

---

## 確定済みの設計判断（このセッションでユーザー承認）

1. **WebGL/three失敗時 = 明示エラー表示**。旧iframe版に黙ってフォールバックしない（CLAUDE.md: No silent errors / No fallbacks）。
   - three の動的import失敗 → ノード上に赤エラー「three.js failed to load: <理由>」
   - WebGL context生成不可 → 赤エラー「WebGL unavailable」
   - context lost で restore不能 → 赤エラー（後述、CPU保持typed arrayから再upは試みる）
2. **transport = 既存WS + base64**。backend→frontend WS は `send_text(JSON)` 固定で `send_bytes` 不可（実測確定）。
3. **Phase0/1 は float32 + 量子化なし**。uint8最適化は後フェーズ。
4. **colormap = matplotlib公式256版 inferno に、新経路・旧iframe版の両方を揃える**（ユーザー決定 2026-05-24）。詳細は §B。
5. **payload schema のスカラー場キーは `field_b64`**（`verts_b64`にしない — 中身は頂点座標でなく高さマップ）。
6. **新旧ピクセルdiff検証をPhase0成果物に含める**（検証6）。Phase1で「色違い/データ違い」を切り分けるため。

> 上記4-6は Claude Desktop レビュー(2026-05-24)で必須化。元の6点必須(§9)に加わる。

### colormap 方針の決定経緯（実測ログ — 後から読む用）

Desktop は当初「9点LUTを移植、公式256版にしない（旧と差が出る）」を推奨。だが実測の結果ユーザーが**両方を公式版に揃える**判断:
- **9点LUT vs 公式256 の色差**: 平均 27/255、最大 51/255（t≈0.88）。中間〜高輝度で9点版が「暗く赤紫寄り」、公式版が明るいオレンジ〜黄。→ **見栄えは公式版が上**。
- **強度は高さ(z)でも読める**ので中間色差は許容、かつ「今の9点色がベスト」という根拠もない → 公式版採用。
- **新旧比較が壊れる懸念への対処**: 「旧=9点・新=256」だと壊れるが、**旧iframe版も公式256に差し替えて両方256**にすれば一致する。
- **黒(低レベル)→透明の再現性は影響なし（実測）**: 透明化はシェーダー `if(max(rgb)<0.06) discard;`（colormap出力への閾値、テーブルそのものではない）。
  透明境界 t: 公式=0.0274 / 9点=0.0249、差 **t=0.0025 = 0.1 dB**（-40..0スケール）。事実上ゼロ。閾値 `l<0.06 discard` は不変で残す。

**注意**: 旧iframe版のLUTも書き換えるため、既存 `.rcflow` の旧 surface3d 表示も今後は公式版の色になる（ユーザー了承済み）。

---

## 確定済みの実コード前提（このセッションで実測確認）

| 箇所 | 状態 | Phase0での扱い |
|------|------|---------------|
| `backend/plugins/python_canvas/kernel.py:173` `_RICH_MIME_TYPES` | `["image/png","image/jpeg","image/svg+xml","text/html","text/plain"]` | 新mimeを**先頭**に追加（1行）。`_extract_rich_data`(L237)は`data[mime]`をそのまま渡すので不変。L224のfallback判定にも新mimeは入らない=fallbackしない |
| `frontend/js/components.tsx:645-655` | mime分岐の if 連鎖（png/jpeg → svg → text/html→iframe） | **先頭**に新mime分岐を1つ追加。既存3分岐は不変 |
| `frontend/js/components/` | コンポーネント置き場（11ファイル） | ここに `Surface3D.tsx` と `SurfaceRendererManager.ts` を新設 |
| `package.json` dependencies | `three` 未追加 | `three` + devDep `@types/three` 追加（0.160系=r128 API互換） |
| n31 Plot Library | `data.defaultParameters.code`(28121 chars)。`surface3d`/`surface3d_pair`/`_surf_db_payload` 等。payload を inline+popb64 に**二重焼き込み**(=真因) | `surface3d_gl`/`_emit_surface_gl` を**追加**（既存関数は温存=Phase3まで現役） |
| ベースライン | `npm run build` 通る（エラーなし） | 変更後も通すこと |

**真因の再確認（n31 surface3d L100-133）**: payload(JSON文字列)を `inline`(L132)に1回 + `popb64`(L130, base64でpop_docを丸ごと)にもう1回 = 同じ頂点が文字列で約4重保持 → string 1GB。新経路は payload を**1回だけ**メタJSON内に持ち、Expandは同じtyped arrayを再利用する。

---

## 新mime

```
application/x-hiyocanvas-surface3d
```

### payload schema（kernelがこのmimeでemitするJSON文字列）

```jsonc
{
  "kind": "single",              // Phase0は"single"のみ。pairはPhase2
  "title": "...",
  "status": "...|null",
  "nrows": 480, "ncols": 512,    // グリッド寸法 (row-major)
  "H": 0.35,                     // 高さスケール（既存surface3dと同じ）
  "xr": [min, max], "yr": [min, max],
  "xlabel": "range [m]", "ylabel": "azimuth [m]",
  "dtype": "float32",            // Phase0/1固定。後でuint8追加
  "field_b64": "<base64>"        // dB正規化済みスカラー場 t値(0..1)。row-major Float32Array をbase64。長さ=nrows*ncols
}
```

- **命名（Desktop提案3反映）**: 中身は3D頂点座標(x,y,z)ではなく**スカラー高さマップ(t∈[0,1])**。頂点座標はフロントが
  `nrows/ncols/xr/yr/H` から計算する。よってキーは `verts_b64` ではなく **`field_b64`**（template変数 `tv` と一致）。
  comment: "dB-normalised scalar field values (t in [0,1]), row-major, Float32Array"。
- **t値の定義は既存と同一**: `dbv = clip(20*log10(A/A.max()+1e-12), -40, 0)`, `tv = (dbv+40)/40` (0..1 float32)。
  → 新旧ピクセル比較(Phase1)が成立するよう**dB正規化のロジックを既存`_surf_db_payload`と1bitも変えない**。
- **max-poolしない**（Phase0は小さい1枚で実証なので元々cap内。pool引数は受けない）。
- field_b64 = `base64.b64encode(tv.astype(float32).tobytes())`。フロントで `new Float32Array(decode.buffer)`。
- **base64長の計算式（Desktop提案7反映）**: float32 N要素 → `4*N` バイト → base64長 = `ceil(4*N/3)*4`（パディング込み）。
  例 32×32: `4*1024=4096B` → `ceil(4096/3)*4 = 1366*4 = 5464`文字。検証3でこの値と一致を確認。

---

## フロント実装仕様

### A. `frontend/js/components/SurfaceRendererManager.ts`（新規）

**単一WebGLレンダラーを全Surface3Dで共有する singleton。** three.js "one renderer, multiple canvases/elements" パターン。

責務:
- `THREE.WebGLRenderer` を1個だけ生成・保持（lazy: 最初の register 時）。
- 各 Surface3D は自分の DOM要素（描画先div）を register する。Manager は単一の `<canvas>` に各要素の bounding box へ描画。
  - **スコープ判断（Desktop提案2反映）**: 「最小実装」と「複数枚汎用化」は両立しにくくトレードオフ。よって
    **インターフェースは複数枚対応で設計し、Phase0の実装は1枚専用**にする（中途半端な汎用化を避ける = CLAUDE.mdスコープ原則）。
    - API: `register(el, data)` / `SurfaceHandle` は最初から複数登録を想定（配列管理、Mapで el→handle）。
    - 実装: Phase0は「登録された1個の element の rect に canvas を合わせて render」で可。
      **scissor/viewport による multi-element 共有描画は Phase3 で Manager を書き直す前提**（書き直しコスト < 中途半端な汎用化コスト）。
      → 設計書にこの意図を一文残すこと（将来「なぜ1枚専用なのか」が分かるように）。
- **rAF レンダーループは2モード**: インタラクション中=毎フレーム / 静止時=データ変更時のみ（dirtyフラグ）。全Surface3Dが**同一rAFループ**を共有（Managerが回す）。
  - **rAF停止条件（Desktop提案6反映）**: **register数 > 0 のときだけ rAF を回す**。dispose で 0 になったら停止。
    SARフロー以外のページ（pandas表示等）で rAF が回りっぱなしにならないように。
- **WebGL context lost対応（必須）**:
  - canvas に `webglcontextlost`(preventDefault) / `webglcontextrestored` リスナ。
  - **CPU保持の方針（Desktop提案4反映）**: 各 Surface3D は **t値(スカラー場)のFloat32ArrayのみCPU保持**。
    position/color等の頂点バッファは**保持しない**（メモリ2倍を避ける）。restored時に t値 + nrows/ncols/xr/yr/H から
    **position/colorを再計算してGPU再アップロード**（格子展開 `x=lerp(xr,j/(C-1)), z=lerp(yr,i/(R-1)), y=H*tv[k]` はJSで十分速い）。
  - restore不能時は登録中の各 Surface3D に**エラー通知**（赤表示させる。silent禁止）。
- three は**動的import**（`await import('three')`）でSAR以外のバンドル肥大回避。import失敗はthrow（呼び出し側が赤表示）。

公開API(案。エージェントが詳細決定可、ただしこの責務を満たすこと):
```ts
interface SurfaceData { nrows:number; ncols:number; H:number; xr:[number,number]; yr:[number,number];
  xlabel:string; ylabel:string; title:string; status:string|null; verts:Float32Array; }
class SurfaceRendererManager {
  static instance(): SurfaceRendererManager;
  async register(el: HTMLElement, data: SurfaceData): Promise<SurfaceHandle>;  // threeをここでimport
  // SurfaceHandle: setData(d), requestRedraw(), dispose(), onError(cb)
}
```

### B. `frontend/js/components/Surface3D.tsx`（新規）

新mimeを描画する React コンポーネント。`surface3d`(iframe版)の見た目を踏襲:
- inferno colormap、colorbar(dB)、title、status、Expandボタン、grid、軸tick、ドラッグ回転/パン/ホイールズーム。
- payload(base64)を `Float32Array` にdecode → Manager.register に渡す。
- **stringゼロ原則**: payloadのbase64文字列はdecode後に参照を捨てる（GC可能に）。HTML文字列に焼き込まない。
- **Expand**: window.open+base64二重持ちでなく、React モーダルで**同じ typed array を再利用**（コピーゼロ）。Phase0はモーダル骨組み（ボタン→全画面表示、同じManager登録）でよい。
- **エラー表示（明示）**: register が reject / three import失敗 / WebGL不可 / context lost不能 → コンポーネント内に赤いエラーボックス（既存 `ErrorDisplay` 流用可）。**旧iframeにフォールバックしない**。

#### colormap = matplotlib公式256版 inferno（新経路・旧iframe版の**両方**を揃える）

> ユーザー決定: 公式版の方が見栄えが良く（9点版は中間〜高域が暗く赤紫寄り、平均27/255差）、強度はzで読めるので採用。
> 新旧比較が壊れないよう **旧iframe版の9点LUTも公式256版に差し替えて両方を一致**させる。

- **公式256 LUT を生成して両経路で共有**。matplotlib `matplotlib.colormaps['inferno']` の 256×3 を `[r,g,b]` 0..1 で出力。
  - 生成方法（BE側で一度だけ）: `[[round(c,5) for c in matplotlib.colormaps['inferno'](i/255)[:3]] for i in range(256)]`。
  - **配置**: 新フロント `Surface3D.tsx`（または共通 `frontend/js/colormap_inferno.ts` 推奨）と、n31 `_SURF_TEMPLATE`/`_SURF_PAIR_TEMPLATE`
    の両方が**同一の256配列**を使う。フロントとtemplateで配列が1値もずれないこと（diff検証で担保）。
  - **lookup**: `inferno(v)` は `idx=clamp(round(v*255),0,255)` の nearest（256段あれば線形補間不要、軽い）。
    旧 `_SURF_TEMPLATE` の `inferno(v)`（9点線形補間）を **256 nearest 版に置換**。新フロントも同じ nearest。
- **旧iframe版テンプレの書き換え（新旧一致のため必須）**: n31 `_SURF_TEMPLATE` と `_SURF_PAIR_TEMPLATE` の
  `const LUT=[9行]` と `function inferno(v){9点線形補間}` を、**256版LUT + nearest版 inferno** に置換。
  → 既存 `.rcflow` の旧表示も公式色になる（ユーザー了承済み）。
- **透明化は不変**: シェーダー `if(max(rgb)<0.06) discard;` はそのまま。透明境界の差は実測0.1dBで無視可。
- colorbar(svg dB目盛, FLOOR=-40, barH)・カメラ操作（sph球面, theta/phi/r, wheel 1.1/0.9, pan sph.r*0.0016）は
  `_SURF_TEMPLATE` と**同一**（colormapのみ差し替え、他は不変）。
- **共通モジュール化（推奨）**: 256 LUT は frontend と n31 template の2箇所で必要。二重定義のズレを防ぐため、
  Phase0では「両者が同一値」を diff検証で確認。完全な単一ソース化（生成スクリプト→両方へ注入）はPhase3整理で可。
- **license（Desktop提案5）**: matplotlib colormap は BSD-3-Clause。256配列を新規に取り込むので、
  `colormap_inferno.ts`（or 該当箇所）冒頭に出典コメント1行（"inferno colormap data © Matplotlib, BSD-3-Clause"）を入れる。

### C. `frontend/js/components.tsx`（既存編集、L645分岐に1つ追加）

```tsx
// 先頭(png分岐の前か後、ただしtext/htmlより前)に追加:
if (d.mime_type === 'application/x-hiyocanvas-surface3d')
  return <Surface3D key={i} payloadJson={d.data} />;
```
既存の png/jpeg/svg/text/html 分岐は**一切変更しない**。import文に `Surface3D` 追加。

---

## バックエンド実装仕様

### D. `backend/plugins/python_canvas/kernel.py`（既存編集、1行）

```python
_RICH_MIME_TYPES = ["application/x-hiyocanvas-surface3d", "image/png", "image/jpeg", "image/svg+xml", "text/html", "text/plain"]
```
他は不変。`_extract_rich_data` も `data[mime]` 透過なので変更不要。

### E. n31 Plot Library に `surface3d_gl` + `_emit_surface_gl` 追加

既存 `surface3d`/`surface3d_pair`/`_surf_db_payload` は**削除しない**（Phase3まで現役）。新規追加:

```python
def _emit_surface_gl(tv, xa, ya, title, xlabel, ylabel, status, H=0.35):
    """Emit the surface as the new binary single-renderer mime.
    tv: float32 0..1 dB-normalised grid (same definition as _surf_db_payload).
    Vertices go out as base64(Float32Array) — emitted ONCE (no double-embed)."""
    import numpy as _np, base64 as _b64, json as _json2
    tvf = _np.ascontiguousarray(tv, dtype=_np.float32)
    nr, nc = tvf.shape
    meta = {'kind':'single','title':title,'status':status,
        'nrows':int(nr),'ncols':int(nc),'H':float(H),
        'xr':[float(_np.min(xa)),float(_np.max(xa))],
        'yr':[float(_np.min(ya)),float(_np.max(ya))],
        'xlabel':xlabel,'ylabel':ylabel,'dtype':'float32',
        'field_b64':_b64.b64encode(tvf.tobytes()).decode('ascii')}
    _display({'application/x-hiyocanvas-surface3d': _json2.dumps(meta)}, raw=True)
    print('surface3d_gl: %d x %d = %d cells, payload %.1f MB (binary path)' %
          (nr, nc, nr*nc, len(meta['field_b64'])/1e6))

def surface3d_gl(field, x_axis, y_axis, title, xlabel='range [m]', ylabel='azimuth [m]',
                 x_range=None, y_range=None, status=None):
    """Binary single-renderer twin of surface3d (NO max-pool, NO string double-embed).
    dB-normalisation identical to surface3d so old/new pixel comparison is valid."""
    import numpy as _np
    A = _np.abs(field) if _np.iscomplexobj(field) else _np.asarray(field)
    xa = _np.asarray(x_axis); ya = _np.asarray(y_axis)
    if x_range is not None:
        sel=_np.where((xa>=x_range[0])&(xa<=x_range[1]))[0]; j0,j1=int(sel[0]),int(sel[-1]); A=A[:,j0:j1+1]; xa=xa[j0:j1+1]
    if y_range is not None:
        sel=_np.where((ya>=y_range[0])&(ya<=y_range[1]))[0]; i0,i1=int(sel[0]),int(sel[-1]); A=A[i0:i1+1,:]; ya=ya[i0:i1+1]
    dbv = 20*_np.log10(A/A.max()+1e-12); dbv=_np.clip(dbv,-40,0)
    tv = ((dbv+40)/40).astype(_np.float32)
    _emit_surface_gl(tv, xa, ya, title, xlabel, ylabel, status)
```

更新後は `print('plot library ready: ... , surface3d_gl')` に追記。

---

## 検証（Phase0完了判定 — 実測必須）

CLAUDE.md「確認手段がないテストは成立しない」。以下を実測で:

1. **ビルド**: `npm run build` がエラーなしで通る（ベースライン維持）。three が dist に入る（動的import chunk）。
2. **kernel mime**: `python -m pytest tests/ -v` 既存テスト緑（mime追加で壊れてないこと）。
3. **emit確認（最小・アプリ起動なし可）**: 小さい配列(例 32x32)で `surface3d_gl` を kernel 経由 execute → execute結果の display_data に
   `mime_type == 'application/x-hiyocanvas-surface3d'` が1件。`field_b64`長 = **`ceil(4*32*32/3)*4 = 5464`文字**であることを確認（提案7の式）。
   さらにメタJSONをparseし `nrows==32, ncols==32, dtype=='float32'`、`Float32Array(decode)` の長さ==1024 を確認。
4. **描画確認（アプリ起動）**: Electron再起動 → n31直後に `surface3d_gl(小配列)` を呼ぶ一時ノードを置いて run → ノード上に3Dサーフェスが1枚描画される（screenshotで定性確認）。WebGLコンテキストが1個だけ（複数iframe生成されない）。
5. **エラー経路の明示確認**: three import を意図的に失敗させた時（or WebGL無効環境想定のコードレビュー）に赤エラーが出る設計になっていること（コードレビューで担保。実環境破壊は不要）。
6. **新旧ピクセルdiff（Desktop提案1後半 — Phase1の前提を Phase0 で配管確認）**: 同一データ(例: 既存の焦点画像 img を小さめに)を
   旧 `surface3d`(iframe) と新 `surface3d_gl` の両方で表示し、**同一カメラ角・同一サイズで screenshot を2枚撮ってピクセルdiff画像を生成**する。
   - Phase0段階では「colormap LUT/カメラ初期値/colorbarが一致し、diffが**データ起因でなく描画器差のごく微小**に収まる」ことを定性確認（完全一致はアンチエイリアス差で出ない）。
   - これが無いと Phase1 で「色が違う/データが違う/どっち？」の切り分け不能（Desktop指摘）。**diff生成スクリプトをPhase0成果物に含める**（`tmp_pixel_diff.py` 等、screenshot 2枚 → 差分PNG + 最大/平均差を出力）。
   - 注: 旧iframe版も公式256版に差し替え、新も同一256版 → **色は一致するはず**。ここで色差が出たらLUT配列の不一致＝Phase0で潰す
     （フロントの256配列と n31 template の256配列がずれていないか確認）。

---

## エージェント分担案（統括=私）

- **Agent-FE（フロント）**: A=SurfaceRendererManager.ts, B=Surface3D.tsx, C=components.tsx分岐, package.json three追加。npm build通すまで。
- **Agent-BE（バックエンド/Python）**: D=kernel.py mime 1行, E=n31への surface3d_gl/_emit_surface_gl 追加（rcflow内のn31コード書き換え）, 検証3（emit確認スクリプト）。pytest緑まで。

両者の境界 = 新mime文字列とpayload schema（本書で固定）。これさえ守れば並列実行可。
統合後、私が build + Electron再起動 + 描画/screenshot で検証4,5を実施。
