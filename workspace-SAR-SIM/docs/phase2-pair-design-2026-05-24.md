# Phase1.5+2 設計書 — 操作バグ修正 + pair_gl（Full/Crop トグル）

対象セッション: dev-image-target-improve (2026-05-24)
前提: Phase0 完了済み（commit 5b5caa5）。`surface3d_gl`(single) + `Surface3D.tsx` + `SurfaceRendererManager.ts` + 公式256 colormap が landed。
親設計: `phase0-design-2026-05-24.md`、引き継ぎ §9: `image-target-handoff-2026-05-24.md`

## このタスクの2つのゴール（ユーザー要望）

### G1. 操作バグ修正（最優先）
新 gl ノード（Surface3D）上で**マウス回転/ズーム/移動ができない**。
- **原因（統括が特定済み）**: host div に React Flow の `nodrag` `nopan` クラスが無く、ドラッグが React Flow のノード移動/パンに奪われている。旧 iframe 版は外側が `grc-exec-result nodrag nopan`（components.tsx:643）で保護され、かつ iframe 内でイベント完結していた。
- **修正**: Surface3D のインタラクション領域（host div = ポインタを受ける要素）に **`nodrag nopan` クラスを付与**し、ポインタ/ホイールイベントで **`stopPropagation()`**（React Flow へ伝播させない）。
  - `pointerdown`/`pointermove`/`pointerup`/`wheel`/`contextmenu` を host div で受け、`e.stopPropagation()`。`wheel` は `preventDefault` も（既に Manager にある）。
  - Manager 側 `_attachInteraction` は既に host(`entry.el`) にリスナを張っているので、**el に nodrag/nopan を付けて stopPropagation を足す**のが最小修正。
- **検証**: 新ノード上でドラッグ→3D回転する、ホイール→ズーム、右(中)ドラッグ→パン。React Flow のキャンバスが動かない。

### G2. pair_gl（Full/Crop トグル）= Phase2 前倒し
比較に Crop が要る。旧 n18 は `surface3d_pair`（Full=max-pool / Crop=アップサンプル間引きなし、トグル）。新経路にも **`surface3d_pair_gl`** を作り、n41 を pair 化して Full/Crop 両方を間引きなしで見られるようにする。

## payload schema 拡張（pair）

Phase0 single（`kind:"single"`, `field_b64`）に加え、**pair** を追加:
```jsonc
{
  "kind": "pair",
  "a": { "title","status","nrows","ncols","H","xr","yr","xlabel","ylabel","dtype":"float32","field_b64" },
  "b": { 同上 }
}
```
- a=Full, b=Crop。各サブは single の payload と同じ構造（`field_b64` = dB正規化 t値 0..1 の Float32Array base64）。
- single と pair は同じ mime `application/x-hiyocanvas-surface3d`。フロントは `payload.kind` で分岐。

## バックエンド（n31）

`_emit_surface_gl` の隣に追加（既存 single 版は不変、`surface3d`/`surface3d_pair` 等も温存）:
```python
def _surf_gl_sub(field, x_axis, y_axis, title, xlabel, ylabel, status, H=0.35):
    """Build one sub-payload dict (a or b) for pair. dB-norm identical to _emit_surface_gl/_surf_db_payload."""
    import numpy as _np, base64 as _b64
    A = _np.abs(field) if _np.iscomplexobj(field) else _np.asarray(field)
    xa = _np.asarray(x_axis); ya = _np.asarray(y_axis)
    dbv = 20*_np.log10(A/A.max()+1e-12); dbv=_np.clip(dbv,-40,0)
    tv = ((dbv+40)/40).astype(_np.float32); tvf=_np.ascontiguousarray(tv,dtype=_np.float32)
    nr,nc = tvf.shape
    return {'title':title,'status':status,'nrows':int(nr),'ncols':int(nc),'H':float(H),
        'xr':[float(_np.min(xa)),float(_np.max(xa))],'yr':[float(_np.min(ya)),float(_np.max(ya))],
        'xlabel':xlabel,'ylabel':ylabel,'dtype':'float32',
        'field_b64':_b64.b64encode(tvf.tobytes()).decode('ascii')}

def surface3d_pair_gl(field_a, xa, ya, title_a, field_b, xb, yb, title_b,
                      xlabel_a='range [m]', ylabel_a='azimuth [m]', xlabel_b=None, ylabel_b=None,
                      status_a=None, status_b=None):
    """Binary single-renderer twin of surface3d_pair (Full=a / Crop=b toggle).
    NO max-pool, NO string double-embed. dB-norm identical to surface3d_pair."""
    import json as _json2
    if xlabel_b is None: xlabel_b = xlabel_a
    if ylabel_b is None: ylabel_b = ylabel_a
    a = _surf_gl_sub(field_a, xa, ya, title_a, xlabel_a, ylabel_a, status_a)
    b = _surf_gl_sub(field_b, xb, yb, title_b, xlabel_b, ylabel_b, status_b)
    meta = {'kind':'pair','a':a,'b':b}
    _display({'application/x-hiyocanvas-surface3d': _json2.dumps(meta)}, raw=True)
    print('surface3d_pair_gl: A %dx%d / B %dx%d, payload %.1f MB (binary path)' %
          (a['nrows'],a['ncols'],b['nrows'],b['ncols'],(len(a['field_b64'])+len(b['field_b64']))/1e6))
```
- **重要**: dB正規化を `_emit_surface_gl`/`_surf_db_payload` と1bitも変えない（新旧比較の前提）。
- 既存関数削除しない。`print('plot library ready: ...')` に `, surface3d_pair_gl` 追記。

## フロントエンド

### Surface3D.tsx（pair対応 + 操作修正）
- payload を parse し `kind` で分岐。
  - `single`: 現状通り（`field_b64`）。
  - `pair`: a/b 2つを decode（各 Float32Array、decode後 string捨てる）。**Full/Crop トグルボタン**（旧 `_SURF_PAIR_TEMPLATE` と同じ位置・見た目: title下、Full/Crop 2ボタン）。トグルで Manager に setData（mesh だけ再構築、カメラ維持）。
  - Expand モーダルも pair 対応（トグルごと再利用、同じ typed array）。
- **G1修正をここに含める**: host div に `nodrag nopan` クラス、ポインタ/ホイール/contextmenu で `stopPropagation`。
- エラー明示は不変（赤ボックス、フォールバックなし）。

### SurfaceRendererManager.ts
- `setData(d)` は既にある（mesh 再構築、カメラ保持）。pair のトグルは Surface3D が「今表示中のサブ(a or b)の SurfaceData」を `handle.setData` で渡せばよい。**Manager は single/pair を意識しなくてよい**（1サーフェス=1データ。トグルは Surface3D が持つ a/b を差し替えて setData）。
- G1: `_attachInteraction` の el に nodrag/nopan は Surface3D 側で付与済みになるので、Manager は **stopPropagation を各リスナに追加**（el に来たイベントを React Flow に伝播させない）。pointerdown/move/up/wheel/contextmenu。

## 検証（実施・報告）
1. `npm run build` 成功（three chunk）。型ベースライン不変。pytest 79 緑。
2. **アプリ起動不要部分**: emit確認 — `surface3d_pair_gl` 相当を小配列(A 16x16, B 8x8)で走らせ、`kind=="pair"`、a/b 各 field_b64 長が `ceil(4*N/3)*4`、decode 長一致を確認。
3. 統括(私)がアプリで実機検証: n41 を pair 化して run、Full/Crop トグル動作、**マウス操作（回転/ズーム/パン）が効く**、React Flow が奪われない、新旧(n18 vs n41)を並べてユーザー目視比較。

## 厳守
- フォールバック禁止 / silent error 禁止。既存関数・既存分岐を壊さない。dB正規化を変えない。
- アプリは起動しない（統括が実機検証）。rcflow は valid JSON 維持、編集前バックアップ可。
- Python: `.venv\Scripts\python.exe`。
- 不明点は推測せず報告。

## n41 を pair 化するコード（統括が後で適用、参考）
```python
# n41 (Step 6b) を pair_gl に:
rg_axis = (t_r - t_r_center) * c / 2
W = PEAK_HALF * view_scale
_rc = np.where((rg_axis >= -W) & (rg_axis <= W))[0]
_ac = np.where((az_pos  >= -W) & (az_pos  <= W))[0]
_sub = img[_ac[0]:_ac[-1]+1, _rc[0]:_rc[-1]+1]
_rgx = rg_axis[_rc[0]:_rc[-1]+1]; _azx = az_pos[_ac[0]:_ac[-1]+1]
F = crop_upsample_factor(len(_azx), len(_rgx))
_mag = upsample_complex(_sub, F)
_rgu = upsample_axis(_rgx, F); _azu = upsample_axis(_azx, F)
surface3d_pair_gl(
    img, rg_axis, az_pos, 'Step 6b FULL (gl, no max-pool, %dx%d)' % img.shape,
    _mag, _rgu, _azu, 'Step 6b CROP (gl, x%d, +/-%dm)' % (F, int(W)),
    status_a='full-res %d verts' % (img.shape[0]*img.shape[1]), status_b='upsample x%d' % F)
```
