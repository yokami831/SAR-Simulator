# SAR画像ターゲット対応 — セッション引き継ぎ報告書 (2026-05-24)

対象フロー: `workspace-SAR-SIM/SAR-Simulator-NUFFT2.rcflow`（ユーザーが NUFFT→NUFFT2 にリネーム、内容同じ。これが最新の作業ファイル）
リポジトリ: 独立リポジトリ `D:\Claude\HiyoCanvas-new`（GitHub: manahiyo831/HiyoCanvas、ブランチ main）

---

## ⚑ 現状（最新・2026-05-24。新エージェントはまずここを読む）

**3D表示メモリ削減の「案A」を実装完了。** 経緯と現状:

1. **方式C（height を GPUテクスチャ化し頂点段でサンプリング）は原理的に不可能**だった — この Electron/ANGLE 環境では**頂点シェーダーのテクスチャフェッチが動かない**（float/uint8 とも頂点段で 0 を返す。フラグメント段は動く。CDP実測確定、詳細§13）。再挑戦無駄。
2. 中間で試した「height を uv.x 属性で渡す版（48N→44N=8%減）」は割に合わず revert（commit a41badd）。
3. **その後 `gl_VertexID` が頂点段で動くことを実測確認 → 案Aを実装（実装済み・詳細§14）。** position は頂点シェーダーで `gl_VertexID` から生成（pos属性廃止）、height は uv.x 属性、color はフラグメントで inferno LUT テクスチャ、**index は同次元(R,C)サーフェス間で共有**（refcount）。geometry = uv(8N) + 共有index。
4. **メモリ実測（CDP）: 現フロー3エントリで 925MB（旧48N ~2327MB 比 約60%減）**、pos/color属性ゼロ・index refcount=2共有を確認。**忠実性: 旧per-vertexとピクセル一致**（gl_VertexIDで同じ式・同じLUT）。runtime0エラー、Full/Cropトグルもリークなし。
5. **罠（恒久）**: position属性が無い→three が boundingSphere を計算できない→`mesh.frustumCulled=false` を必ず設定（忘れるとカリングでメッシュが消える）。indexed draw では `gl_VertexID` = index要素値 = flat k（0..N-1の連番ではない）。ShaderMaterial（RawShaderMaterialでない）を使うこと（three が GLSL3 に変換し gl_VertexID が使える）。
6. **さらに削るなら**: height uv(8N)→uint8 R8(2N相当, but頂点属性は最小4byte/成分なので uv.x float のまま8N) や、height を1成分カスタム属性(4N)化（前回 `aT` がバインドされなかった罠の解明要）。現状で足りているなら不要。

**ANGLE頂点テクスチャ不可・案A実装は CLAUDE.md にも恒久記載済み。** 数式・NUFFT・Fs等の他の知見は §2 以降を参照（有効）。

---

## 1. このセッションで達成したこと（サマリ）

点ターゲット専用だったSARシミュレータを、**NUFFTによる画像ターゲット対応**に拡張し、Electronレンダラーの**メモリ(OOM)問題を解決**した。

1. **NUFFTを唯一のecho生成に一本化**（時間領域echo n7 を削除）
2. **画像ターゲット**（PNG等の各ピクセル→散乱点）対応。small.png(ハート)/strix(フクロウロゴ)で焦点画像を確認
3. **1ピクセル=1分解能セル**配置で連続形状を再現
4. **レンダラーOOM(白画面)を解決** — 3層のメモリ対策
5. **クロップ表示の間引き問題を修正**（アップサンプル詳細を粗くしない）
6. Fixed Parameters(n30) に **Sampling rate Fs** 表示を追加

コミット: `62313f5`(NUFFT echo+診断) → `380a4c5`(OOM診断) → `162a5f0`(一本化+画像+メモリ3層) → `3721484`(small.png検証) → `41b51e9`(1px=1分解能セル) → `a99fe9d`(クロップ間引き修正+Fs表示)。全てpush済み。

---

## 2. NUFFT echo生成の仕組み（n32 "Reflection / Raw Echo (NUFFT)"）

### 由来
`workspace_TargetSim/TargetSim/`（`TargetSim_FPGA.rcflow` n9+n32, `TargetSim_GPU_Report.md`）からの移植。Windowsで cufinufft/torchkbnufft/pynufft が全滅したため **CPU版 finufft 2.5.1** を採用（cupy 14.0.1 + finufft 両方 .venv にあり）。

### なぜNUFFTか
echo生成 `S[f_k] = Σ_j w_j·exp(-j2π·f_k·τ_j)` は不均等点→均等グリッドのフーリエ変換 = NUFFT Type1。コストは **O(Nr·logNr + 散乱点数)** で、**点数が処理時間にほぼ影響しない**。時間領域ループ O(Na·Nr·点数) では画像(10^5点)は処理不能だが、NUFFTなら現実的（実測: ya.png 7495点=0.64s、strix_small 50137点=1.52s）。

### 数式の規約（load-bearing。間違えると焦点画像が崩壊）
```
W_j      = refl_j · sinc(arctan2(daz,sr)/theta_az)^2 · exp(-4j·pi·R_eta/lam)   # R_eta/carrierはfloat64
x_j      = (-2·pi·Fs·(tau - t_r_center)/Nr).astype(float32)   # finufft complex64 planはfloat32座標必須
S[eta]   = ifftshift( nufft1d1(x_j, W_j, Nr, isign=+1, eps=1e-6) )
chirp_fft= fft(ref_chirp)         # ref_chirpは中央寄せ済み。ifftshiftもconjも掛けない
s_raw[eta] = ifft(chirp_fft · S[eta])
```
- finufft Type1出力は **centered modes** → `ifftshift` で natural order に直す
- 帯域制限遅延の検証参照には **signed freq** (`np.fft.fftfreq*Nr`) を使う（k=0..N-1 ではダメ）
- カーネル: GPU(CuPy)で距離/角度/アンテナ/位相を前計算 → CPU finufft(nthreads=1)を ThreadPoolExecutor で並列

### 検証結果（点ターゲット）
- NUFFT vs（旧）時間領域n7 = **26.7 dB**（バグでなく本質的なモデル差: n7はハードrect窓+解析チャープ再評価でGibbs、NUFFTは帯域制限シフト。整数遅延では一致、分数遅延でrect端に差）
- NUFFT vs 厳密band-limited DFT = **90.6 dB**（complex64+epsの精度床）→ NUFFTは数値的に正確

---

## 3. 画像ターゲットの仕組み

### GUIブロック（n32より前に実行され namespace に変数を供給）
| ノード | type | var_name | 値 |
|--------|------|----------|-----|
| n33 | gui_dropdown | `target_mode` | point / image |
| n37 | gui_file_picker | `image_path` | 画像の絶対パス |
| n39 | gui_toggle | `invert_image` | true / false |

### 配置ロジック（n32内）
- 各非ゼロピクセル → 1散乱点。`(az=0, slant=R0)` 中心。
- **1ピクセル = 1分解能セル**: `_sp_rg = c/(2B)`（slant range分解能）, `_sp_az = La/2`（azimuth分解能）。これにより隣接ピクセルが隣接分解能セルに収まり**連続形状**として焦点化される（旧「窓90%フィット」だとspacing 9.6m >> 分解能2.5mで点列に分裂していた）。
- ピクセル輝度 → 反射率振幅（実数）
- `invert_image`: **白地に図柄（写真・small.pngのハート）→ invert=False（明るい=反射強）**、**黒地に白線（線画・ya.png/strix）→ invert=True（暗い=反射強）**

### テスト画像（`workspace-SAR-SIM/images/`、git管理下）
- `small.png` 45×45（白ハート、invert=False で98点）← 最小確認用
- `ya.png` 260×260（線画、invert=True で7495点）
- `strix_small.png` 256×256（フクロウロゴ、50137点）

### GUI値変更の罠（重要）
**`update_element` では GUI ブロックの `value` が更新されない**（"Updated (n)" と返るが無変化）。値を変えるには **add_element 時に設定** するか、**削除＆再追加**する。スライダー(view_scale等)も同様。

---

## 4. メモリ問題 — 制限の階層（恒久的に関係する。詳細はCLAUDE.md参照）

白画面クラッシュ = **レンダラーV8ヒープのOOM**。`logs/renderer-crash.log` に `render-process-gone reason="oom"` で記録される（診断は src/main.js + src/preload.js、コミット 380a4c5）。

| 制限 | 上限 | 性質 | 帯域幅B↑の影響 |
|------|------|------|---------------|
| ① レンダラーV8ヒープ | **~4GB硬上限** | Electron14+のポインタ圧縮。`--max-old-space-size`等で**変更不可**（実測 jsHeapSizeLimit=4096固定） | Nr増→表示頂点増→直撃 |
| ② WebGLコンテキスト | ~16個/同時 | ブラウザ制約 | 影響小 |
| ③ 計算 RAM/VRAM | 64GB / GPU VRAM | システム依存 | Na×Nr配列が増大、いずれ要検討 |

**①が白画面の主犯。** 4GBは上げられないので「使用量を減らす」しかない。

### メモリ対策3層（すべて実装済み・検証済み）
1. **surface3d_pair（トグル化）**: full/crop の2枚を1 iframe + 1 WebGLレンダラー共有、Full/Crop切替ボタンでメッシュだけ再構築（コンテキストは作り直さない）。iframe 12→7、heap 5004→2905MB。
2. **頂点max-pool間引き（フルビューのみ）**: 表示payloadの頂点が `MAX_VERTS=250000` を超えたらmax-poolで間引く。**表示専用・物理配列は無傷**。max-poolなので点ターゲット/線は消えない。画像サイズに依らず表示頂点を一定上限に抑える＝**大画像対策の要**。
3. **中間3Dプロット(n19/n20/n21)をDisable**（画像モードの通常状態）。

結果: 画像モードで heap **5004MB(クラッシュ) → 116〜355MB**（上限4096に対し圧倒的余裕）。

### 間引きの設計原則（ユーザーの強い要望: アップサンプルした詳細は粗くしない）
| 表示 | 間引き | 理由 |
|------|--------|------|
| フルビュー(A) | max-pool あり (`pool_a=True`) | 全体把握用。粗くてOK、点は保持 |
| 2Dクロップ(B, n18/19/27) | **間引きなし** (`pool_b=False`) | アップサンプル率Fを `crop_upsample_factor()` で上限に合わせ調整。詳細を粗くしない |
| range-onlyクロップ(B, n20/21) | **range軸=無傷、Doppler行のみ間引き** (`pool_b='rows'`, `_maxpool_rows_to_cap`) | range(アップサンプル詳細)は保持。非アップサンプルのDoppler行だけ間引いて上限内に |

`crop_upsample_factor(n_rows, n_cols, cap, fmax=6, range_only=False)`:
- 2D: `F = floor(sqrt(cap/(R·C)))`
- range_only: `F = floor((cap/R - 1)/(C-1))`
クランプ [1, fmax]。固定F=6をやめ、これでFを決める。

---

## 5. サンプリング周波数の扱い

- **Fs は n1 で手動固定**（`Fs = 72e6`、コメントは "= 1.2*B" だが**式ではない**）。`dt_r = 1/Fs`。Bからは自動計算されない（**手動制御がユーザーの意図**）。
- サンプル間隔(距離) = `c/(2Fs)` ≈ 2.08m（グリッド刻み）。range分解能 = `c/(2B)` = 2.5m（**別物**）。今 Fs/B=1.2 でオーバーサンプリング気味＝正常。
- **n30 (Fixed Parameters) に表示追加**: `Sampling rate Fs: 72 MHz (Fs/B = 1.20, cell = c/(2Fs) = 2.08 m)`。Fs/B比はエイリアシング監視用（B↑でFs据え置きだとFs/Bが下がる→1.0割れで折り返し危険）。
- **注意**: B を上げる実験をする時は Fs も手動で上げる必要あり（Fs ≥ 1.1〜1.2×B を維持しないとエイリアシング）。Fs↑→Nr増→①メモリを圧迫。

---

## 6. 現在のフロー構成（本流）

```
n1(params) → n2(chirp+grid) → n3..n6(送信チェーン/Antenna)
  → n32(NUFFT echo, s_raw生成・画像対応) → n25(LNA noise)
  → n9..n13(受信チェーン placeholder) → n14(Range Comp)
  → n15(Az FFT) → n16(RCMC) → n17(Az Comp) → n18(焦点画像表示)
表示: n18(焦点) 有効 / n19,n20,n21(中間) Disable / n27(raw echo) / n30(Fixed Params) / n31(Plot Library)
GUI: n23(n_targets) n24(view_scale) n26(noise) n28(clutter_n) n29(clutter_rcs) n33(target_mode) n37(image_path) n39(invert)
```
削除済み: n7(時間領域echo), n8(Plot Raw Echo), 旧n33(Compare)。

---

## 7. 運用ルール（このプロジェクトで学んだ。CLAUDE.mdにも記載）

1. **フロー実行中に canvas API 操作(connect/update/add)を送らない** — レンダラーが負荷下で脆く、クラッシュする。実行中は server-side narrator（read-only HTTP）でポーリングし、`flow_completed` 後に編集。
2. **構造変更のたびに save_tab** — レンダラークラッシュで未保存分が消えるため。
3. **GUI値は update_element で変わらない** — add時設定 or 削除＆再追加。
4. **エージェントの「できました」は実測で裏取り** — 特に専門領域。今回コード確認+CDP計測でバグ混入を防いだ実績あり。
5. **canvas_api の @file パターン** — 大きい/日本語JSONは UTF-8 ファイルに書いて `'@file'`（単一引用符）で渡す。インラインJSONはPowerShellが壊す。

---

## 8. 未解決・次セッションの候補（画像対応の改善 継続）

- **view_scale を上げた時の自動調整** — 大画像が View窓を超える場合の挙動。現状は手動でview_scaleを合わせる必要。画像サイズに窓を自動フィットする案。
- **大画像の実地確認** — strix.png(1024×1024, 678k点)、photo_large(3.7M点) での速度・メモリ。NUFFT側は点数非依存だが ③計算メモリ(Na×Nr配列)の限界を見積もる。
- **Fs変更時のエイリアシング可視化** — B↑/Fs据え置きで折り返しが出る様子を見せる。
- **画像の回転/スケール/位置** のGUI制御（今は中心固定・分解能セル固定）。
- **MAX_VERTS のチューニング** — 250kが妥当か。サイドローブ詳細を厳密に見たい時の上げ下げ。
- **invert の自動判定** — 画像の地色から invert を推定（今は手動トグル）。

### 検証の起点（次セッションで動作確認する手順）
```
# 起動確認
.venv\Scripts\python.exe .claude\skills\hiyocanvas-bridge\scripts\ctl.py status
# フロー状態
.venv\Scripts\python.exe .claude\skills\hiyocanvas\scripts\canvas_api.py get_tabs
# 画像モードで実行（実行中は操作しない、narratorでポーリング）
.venv\Scripts\python.exe .claude\skills\hiyocanvas\scripts\canvas_api.py run
# メモリ実測（CDP, aiohttp; .hiyocanvas-runtime.json の cdpPort 経由）
```

---

## 9. 【次の大仕事】忠実表示のためのバイナリ・単一レンダラー第2表示経路（設計確定済み・未実装）

### 背景: なぜこれをやるか
現在のメモリ対策は **max-pool間引き**（表示頂点を25万に削減）を含む。だが**間引きは常に見た目を変える**ため、ユーザーの本来の目的「忠実表示」に反する。間引きを**完全廃止**して全頂点を忠実表示しつつ4GB上限に収めるのが目的。

### 真因（ヒープスナップショット実測で確定。CLAUDE.md にも記載）
白画面OOMの主犯は頂点データそのものでなく **HTML文字列の多重保持 = string 1005MB**。surface3d は payload(t配列)をJSON文字列でHTMLに埋め込み、さらにExpand用にHTML全体をbase64で二重持ち → 同じ頂点が文字列で約4重。（native ArrayBuffer の pos/col は593MBで正当、number[] の D.t は117MBで主犯でない。）

### 採用する設計（ユーザー決定 + Claude Desktopレビュー反映）
**「既存iframe経路は温存し、SAR 3D表示専用の第2経路を追加」**（本体の汎用表示=pandas表/matplotlib画像/他フローには一切触れない）:

- **新mime `application/x-hiyocanvas-surface3d`**。kernelは新function `surface3d_gl`/`surface3d_pair_gl` で「小さいJSONメタ + 頂点をbase64」を1回emit。**transport=既存WS+base64で確定**（実測: backend→frontend WebSocketは `send_text(JSON文字列)` 固定、`send_bytes`未使用 = バイナリフレーム不可。Desktopの「binary mimeでbase64回避」はこの経路では不成立。uint8 base64の一時string 3.4MBは真因1GBと桁違いでGCされるため実用上OK）。
- **kernel.py**: `_RICH_MIME_TYPES`(line 173) に新mimeを先頭追加（1行、既存不変）。`_extract_rich_data` は `data[mime]` をそのまま渡すので変更不要。GL functionは `display({mime: json}, raw=True)` でその mime のみ emit。
- **components.tsx**(~line 650): 新mimeのときだけ iframe でなく React `Surface3D` コンポーネントで描画（既存 text/html→iframe 分岐は不変）。
- **単一WebGLレンダラー共有**: 全サーフェスが1つの WebGLRenderer を scissor/viewport で共有（three.js "one renderer, multiple elements"）。WebGLコンテキスト16個制限から解放。colorbar/title/status/toggle/Expandボタンは React/DOM オーバーレイ。
- **three を npm依存に追加**（今はiframe内CDN r128。React側はモジュールimport要）。動的import推奨でSAR以外のバンドル増回避。0.160系がr128 API互換。
- **max-pool完全廃止**（MAX_VERTS/_maxpool_to_cap/_maxpool_rows_to_cap/pool引数を削除）。crop の意図的アップサンプル(crop_upsample_factor/upsample_*)は維持。
- **Expand**: window.open+base64二重持ちでなく React モーダルで同じtyped array再利用（コピーゼロ）。
- 旧 surface3d/surface3d_pair（iframe版）は汎用フォールバックとして温存、SARフローは _gl 版に移行。

### Claude Desktopレビューで必須化した点（実装時に必ず守る）
1. **Phase1 は float32 + 量子化なし**で実装し「忠実・単一コンテキスト・stringゼロ」を確定 → その後 uint8 をオプション追加（最終的に uint8 で十分=ユーザー/Claude合意、ただし変更を1つずつ切り分けるため実証はfloat32から）。
2. **WebGL context lost ハンドリング必須**（`webglcontextlost`/`restored`）。単一コンテキストは失うと全プロット消える（TDR/スリープ復帰で起きる）。**typed array を CPU 側に保持して再アップロード可能に**（decode後にGPUへ送ってCPU側を捨てる設計にしない）。
3. **新旧ピクセル比較**を Phase1 検証に必須: 同じ焦点画像を旧 surface3d(iframe+maxpool) と新 surface3d_gl(間引きなし) で並べ、ピーク位置・dB色対応・カメラFOVが一致するか。「downsampling artifactを物理現象と誤認」の再演防止。
4. **React Flow ノード仮想化の罠**: 画面外ノードがDOMから外れ getBoundingClientRect 不可になりうる。仮想化無効化 or React Flow state からノード位置取得。
5. **中間プロット再有効化の上限設計**: プロット数×頂点数に上限、超えたら黙らず警告（エラーは明示）。Phase4で n19/20/21 を再有効化する際に。
6. レンダーループは2モード（インタラクション中=毎フレーム / 静止時=データ更新時のみ）、全プロットが同一rAFループに。

### メモリ見積もり（変更後、全7プロット full-res 2.58M頂点）
string ≈ 0（base64 3.4MB×一時のみ、GC）、GPU側 pos/col/index ≈ 600〜900MB（V8 4GB枠外）。→ max-pool不要、4GB余裕、中間プロット再有効化可。GPU VRAM(RTX 3060=12GB)の他用途(DWM等)も考慮、context lost対策必須。

### 段階導入（Phaseを1つずつ検証）
- **Phase0(基盤)**: three+@types/three追加、Surface3Dコンポーネント骨組み+SurfaceRendererManager singleton+components.tsx分岐、kernel.py mime追加、n31に surface3d_gl/surface3d_pair_gl/_surf_gl_part/_emit_surface_gl 追加。npm build + 再起動。
- **Phase1(1枚で実証)**: n18焦点画像のみ _gl に（float32、量子化なし）。検証: 忠実full-res / 単一コンテキスト / stringゼロ(ヒープスナップショット) / 新旧ピクセル比較 / context lost対応。
- **Phase2**: pair の Full/Crop toggle と Expand モーダル検証。
- **Phase3**: 残り(n6,n19,n20,n21,n27)を _gl に移行、pool引数削除。
- **Phase4**: 中間プロット(n19/20/21)再有効化（上限設計付き）、max-pool削除、未使用なら旧iframe版削除。uint8オプション追加。

### 実装対象ファイル
- `backend/plugins/python_canvas/kernel.py`（mime追加 line173）
- `frontend/js/components.tsx`（新分岐~line650 + Surface3Dコンポーネント + SurfaceRendererManager）
- `package.json`（three + @types/three）
- n31 Plot Library（`SAR-Simulator-NUFFT2.rcflow` 内、+ tmp_n31_full2.py が可読コピー）: _gl functions追加、max-pool削除
- 呼び出しノード n6/n18/n19/n20/n21/n27 を _gl に移行
- フロントエンド変更なので **npm run build + Electron再起動が必要**（これまでのcanvas APIのみ変更と違う）

### Claude Desktop 連携メモ
この設計はClaude Desktop（claude-desktop-bridge skill）の「iframe撤廃」提案が発端。Desktopとのチャットは継続中。設計レビュー依頼は `tmp_desktop_review.md`（一時)で送付済み、Desktopから上記6点の指摘を受領・反映済み。次セッションで実装の節目にまたDesktopに相談すると良い。

---

## 10. 【SKILL / API 修正点リスト】update_element 周りの不備（要修正・未着手）

調査でわかった `update_element` の問題。**コードは未修正**、修正点として記録のみ（次セッションで本体修正 or SKILL doc 修正）。

### 確定した事実（backend `backend/tools/canvas.py` の update_element を実読して確認）
`update_element(node_id, **kwargs)` がトップレベルで受理するのは **`label, code, enabled, code_collapsed, position, width, height`** のみ。GUIブロックの値等の任意パラメータは **`params={...}` dict**（複数形 `params`）で渡すと内部で `update_param` WS コマンドが走る。

| やりたいこと | ❌ 間違い（黙殺される） | ✅ 正しい |
|---|---|---|
| code更新 | `{"parameters":{"code":...}}`（parametersでくるむ） | `{"code":...}`(トップレベル) or `{"code_file":"tmp.py"}` |
| GUI値更新(dropdown/file_picker/slider/toggle) | `{"value":...}`(トップレベル) / `{"parameters":{"value":...}}` | **`{"params":{"value":...}}`**（var_name/min/max等も同様にparams内） |

→ **「GUI値は update_element で変えられない、削除＆再追加が必要」は誤り**だった。正しいキー `params` を使えば更新できる（このセッションで私はこれを誤認し、削除＆再追加で回避していた。実際は不要）。

### 問題A（最重要）: サイレント・フォールバック（CLAUDE.md "No silent fallback" 違反）
update_element は受理リストにないフィールド（`value`, `parameters` 等の間違ったキー）を **どの分岐にもマッチさせず黙って無視**し、さらに `changed`（適用できた項目）が空でも `errors` が空なら **`success: True` を返す**（canvas.py 256-263行: `if errors and not changed` の時だけ False）。
- 症状: `[OK] update_element / Updated: n34 ()` ← **空カッコ＝何も変わっていないのに成功扱い**。
- 害: 呼び出し側（人もエージェントも）が「効いた」と誤認。複数のエージェントがこれに騙された。デバッグ困難。
- **修正案**: (1) 未知のトップレベルフィールドが来たらエラーにする（"unknown field 'value' — use params:{value:...}?"）。(2) `changed` が空なら `success: False`（何も変えていないのに成功と言わない）。

### 問題B: SKILL doc に GUI値更新方法の記載なし
`.claude/skills/hiyocanvas/references/operations.md` の update_element の Parameters 一覧（label/code/enabled/position/width/height）に **`params`（任意パラメータ更新用）が載っていない**。GUIブロックの value/var_name/min/max の変え方が書かれていないため、誰も正しい方法に辿り着けない。
- **修正案**: operations.md の update_element に `params` (dict) を追記し、「GUIブロックの value 等は `params:{"value":...}` で更新」と例示。add_element は `parameters`、update_element は `params`（+ code/label等はトップレベル）という**非対称**も明示的に警告。

### 他APIの監査結果（同じフォールバックがないか確認済み）
- **`_cmd`（多くの操作の基盤、canvas.py:15）= 健全**。frontend が success:false を返せば False を伝播、エラー握りつぶしなし。
- **`add_element` = 健全**（_cmd失敗を素通し）。
- **`run_batch`（batch.py）= 健全**（各操作のsuccessを伝播、最初のエラーで停止、全成功時のみ全体success）。ただし内部で update_element を呼べるので、update_element のフォールバックは batch 経由でも伝播しうる。
- **問題は update_element に局在**（唯一 `_cmd` を使わず独自にフィールド分解しており、そこにフォールバックが混入）。

### 優先度
1. (A) update_element のサイレントフォールバック除去 ← 最優先（誤認の温床）
2. (B) operations.md に params 追記 ← すぐできる

---

## 11. 【次の大仕事 / 新セッションで実装】heightmap-as-texture (方式C) で超大グリッド対応

### 経緯と現状
画像ターゲットのグリッドを拡大中。Nr=1048→9840(2km)→19000(4km) と増やしており、**3D表示のVRAM/メモリが新たな律速**になってきた。現状フローは既に **GLバイナリ単一レンダラー方式（`surface3d_gl`/`surface3d_pair_gl`, §9参照, 実装済み）** で動いているが、その GL方式でも頂点バッファ（pos/col/index）が頂点数Nに比例して肥大する。**現在ユーザーは4kmを通すため一部の3D表示ノードを手動OFFにして凌いでいる。**

### 現状の頂点メモリ = 48バイト/頂点（実装確認済み: SurfaceRendererManager.ts 255-308行）
1プロット N頂点(=Nr×Na)あたり: pos Float32×3 =12N + col Float32×3 =12N + index Uint32(6/quad) ≈24N = **48N バイト**。
- 全プロットが同時GPU常駐（off-screen自動解放は未実装。register/dispose と CPU側t保持=context lost対応は有り、SurfaceRendererManager.ts）。

| グリッド | 1プロット(48N) | 5枚 | 7枚 |
|---|---|---|---|
| 旧 Nr=1048 | 134MB | 0.67GB | 0.94GB |
| 2km Nr=9840 | 1258MB | 6.3GB | 8.8GB |
| 4km Nr=19000 | 2430MB | 12.2GB | **17GB** |

→ 4km×7枚=17GB > VRAM(RTX3060 12GB)。**最初に詰まるのはGPU VRAM（全プロット合計）**、次に**単一ArrayBuffer ~2GB上限**（8km級でindexが当たる）。WebGL頂点数自体はUint32で42億まで余裕。

### 検討した削減策と定量比較
| 方式 | バイト/頂点 | 4km1プロット | 4km×7枚 | 実装 |
|---|---|---|---|---|
| 現状(GL, pos+col+idx) | 48N | 2430MB | 17GB | — |
| **A: pos/col をシェーダー生成**(t値1ch保持, x/z格子生成, color=シェーダーinferno)。idx(24N)は残る | ~28N | ~1418MB | ~9.9GB | 軽(シェーダー変更) |
| **C: heightmap-as-texture** ← 採用 | **~1N(uint8) / ~4N(float)** | ~95MB / ~380MB | **~0.67GB / ~2.7GB** | 中〜大 |

A は42%減が天井（idx残存、8kmで単一ArrayBuffer 2GB超の恐れ）。**C はほぼ全廃（~98%減）で桁違い、8km以上も射程**。→ **ユーザーは C を選択。**

### 方式C（heightmap-as-texture）の設計
- t値（dB正規化済み[0,1]グリッド、現状 surface3d_gl が emit している `field_b64`）を **GPUテクスチャ**としてアップロード（uint8 か float32 texture。uint8なら~1N、忠実性重視ならfloat32~4N。§のDesktopレビューでは「忠実性のためまずfloat32」方針 — Cでも踏襲推奨、ただしtextureはサイズ影響大なので uint8(0.16dB step)で十分か要検討）。
- **固定の格子メッシュ（1個、全プロット共有可能）** を用意し、**頂点シェーダーでテクスチャをサンプリングして高さ変位 + infernoカラー計算**。→ pos/col/index という巨大バッファが消滅、メモリは texture(N×1〜4byte)のみ。
- 結果: pos/col/index 撤廃。index も格子共有で1個。VRAMが頂点数N×1〜4バイトだけ。4km×7枚でも~0.67GB(uint8)/~2.7GB(float) でVRAM余裕、**手動OFF不要**。

### 速度への効果（C採用の副次メリット）
- **初回表示・フロー再実行が速くなる**（GPU転送が2.4GB→~95MBで1/25、JS側の数千万要素 pos/col/idx 構築ループが消滅）。実行中の重い描画によるレンダラー詰まりも緩和。
- **GCスパイク減**（巨大ArrayBuffer確保/解放が減る）。
- **回転/パン中のFPSはほぼ変わらない**（描画頂点数Nは同じ＝頂点シェーダー実行数同じ）。回転をさらに軽くしたいなら別途 **LOD（表示解像度を落とす）** が必要（C とは独立）。

### 実装対象（既存 GL実装を土台に改造）
- `frontend/js/components/SurfaceRendererManager.ts` — geometry構築(255-308行 pos/col/idxループ)を、固定格子メッシュ + heightmap texture + 頂点シェーダー(変位+inferno)に置換。dispose/CPU-t保持/context lost対応(`_disposeEntryGPU`, 197行のCPU再構築)は維持しtexture再アップロードに対応。
- `frontend/js/components/Surface3D.tsx` — field_b64 decode部(60-83行)は流用。Float32Array(or Uint8)をtextureに渡す形に。
- カラーマップ: 現在 `INFERNO_256_FLAT`(Float32×768) を頂点色に焼いている → **フラグメント/頂点シェーダーで t→inferno をLUTテクスチャ参照** に変更（見た目を完全一致させること: -40..0dB, inferno256, H=0.35高さスケール、カメラ/軸/colorbar/Expand/Full-Cropトグルを維持）。
- kernel側 `surface3d_gl`/`_emit_surface_gl`(n31) は現状の field_b64(float32) emit のまま流用可。uint8 texture にするなら emit を uint8 base64 に変える選択肢も（payloadも1/4に → 転送さらに軽量）。
- three は npm依存済み。フロントエンド変更なので **npm run build + Electron再起動が必要**。

### 検証
- 新旧ピクセル比較（texture方式 vs 現GL方式で焦点画像のピーク位置・dB色・形が一致＝忠実性。Desktopレビューの「artifact誤認再演防止」原則）。
- CDPヒープ/VRAM計測で 4km×7枚が VRAM内に収まること、手動OFFしていた中間プロットを全部ONに戻せること。
- 初回表示・フロー再実行の時間が短縮することを実測。
- context lost → restore でtextureが再アップロードされ表示復帰すること。

### 注意・リファレンス
- §9（GLバイナリ方式）= Cの土台。§のDesktopレビュー6点（float32で忠実性確保→必要ならuint8、context lost対応、新旧ピクセル比較、React Flowノード仮想化、プロット数上限、レンダーループ2モード）はCでも有効。
- 実装の節目で Claude Desktop（claude-desktop-bridge skill）に相談すると良い（このメモリ/3D設計はDesktop発端の継続議論）。
- フロー実行中はcanvas API操作を送らない（§7運用ルール）。
- メモリ定量値は CLAUDE.md「### SAR画像ターゲット & 3D表示のメモリ」にも記載済み（Cで更新する想定: 48N→~1N、4km×7枚 17GB→~0.67GB）。

---

## 12. 【方式C 実装計画（Planエージェント出力、2026-05-24セッション、未着手＝コード未変更）】

次セッションで方式Cを実装する際の確定計画。**この時点でソースコードは一切変更していない**（安全な中断点）。現状コード(`SurfaceRendererManager.ts` / `Surface3D.tsx`)は §9 の GLバイナリ方式のまま正常動作中。

### 結論: 方式Cは1ファイルのリファクタ
変更は **`frontend/js/components/SurfaceRendererManager.ts` の1ファイルに局在**する。`Surface3D.tsx`(decodeSubPayload で field_b64→Float32Array、流用), `colormap_inferno.ts`(INFERNO_256_FLAT を読むだけ), `kernel.py`, n31, `package.json`(three@^0.160 導入済み) は**変更不要**。§9 の土台が既に正しい配管をしているため。

`SurfaceRendererManager.ts` 内の5箇所:
| 編集 | 場所 | 内容 |
|---|---|---|
| A | `SurfaceEntry` interface 67-83 | フィールド追加: `heightTexture`, `gridR`, `gridC`（C3でグリッド共有判定用） |
| B | module scope (~line22) | 共有 `lutTexture`(256×1 RGB float、1回生成) と グリッドgeometryキャッシュ `${R}x${C}`(C3) |
| C | `_rebuildMesh` 235-351 | **pos/col/idx CPUループ(260-308) と ShaderMaterial(311-326) を置換** → height DataTexture + 固定グリッド + 新vertex/fragmentシェーダー。tickスプライト(331-345)とcamera target更新(348)は**そのまま**。 |
| D | `_disposeEntryGPU` 543-557 | `entry.heightTexture?.dispose()` 追加。geometry破棄はC3共有時のみ条件分岐。**`_rebuildMesh`先頭(238-243)の旧mesh破棄にも heightTexture.dispose() 追加**（Full↔Crop toggleごとにtextureリークするため必須）。 |
| E | context-restore 195-209 | 構造変更不要（既に entry毎に `_rebuildMesh` 呼ぶ→texture自動再アップロード）。ただし `lutTexture=null` リセット(loss時)＋capability check追加。 |

### 忠実性の要（load-bearing。ここを外すと見た目が変わる）
現状CPUループ(269-287)が cell(r,c) で出す値を**シェーダーで完全再現**する:
- 位置: `x=c*invC-1`(invC=2/(C-1)), `z=r*invR-1`(invR=2/(R-1)), `y=t*H`
- **グリッドは手動BufferGeometryで作る**（PlaneGeometry の回転/UV順序の罠を回避）。position は現CPU式そのまま(y=0)、index loop(294-303)を**そのまま流用**。
- **height texture = DataTexture(field, C, R, RedFormat, FloatType)**。`field` は `entry.data.field`(既存CPU保持配列、context-restore用)を**コピーせず参照**。
- **NEAREST フィルタ必須**（height も LUT も）。Linear だと高さ/色が補間されて byte-identical が壊れる。現CPUは `tv[k]` 直接参照=補間なし。
- **UVはテクセル中心**: `u=(c+0.5)/C, v=(r+0.5)/R`。整数UVだと境界で1セルずれる。
- **flipY**: DataTextureは既定 `flipY=false`(画像textureと逆)。明示設定し、C1で上下反転が出たら `v=1-(r+0.5)/R` の1行修正で対処（データ転置でなく）。
- **inferno LUT = DataTexture(INFERNO_256_FLAT, 256, 1, RGBFormat, FloatType)**、NEAREST、1回生成・全サーフェス共有・per-entry破棄しない。fragmentで `idx=floor(clamp(t,0,1)*255+0.5)`, `u=(idx+0.5)/256` で参照 → CPUの `(t*255+0.5)|0` と整数一致（byte-identical 論証可、唯一の差は丸め境界のfloat精度=要スクショ確認）。
- 透明床 `if(l<0.06) discard` は**そのまま**。NaN処理 `t!==t→0` もシェーダーで再現(`vT!=vT`)。
- ShaderMaterial: `side:DoubleSide` 維持、`vertexColors:true` は**削除**（color属性が無くなりLUT texture由来になる）、uniforms=`{uHeightTex, uLut, uH}`。

GLSL全文・DataTextureコード・capability check は Planエージェント出力（このセッションのagent結果）に記載。実装時はそれを参照。

### ⚠️ 最重要発見（§11の精緻化）: C3（グリッド/index共有）は必須、任意でない
**§11は「Cはバッファ全廃」と書いたが、height-texture化だけでは pos+col(24N)は消えるが per-entry の index(24N=Uint32×6quad)が残る。** 4km(N=19000×2460)で index だけ ~1.1GB/plot → 7枚で **~7.7GB** になり 12GB に対し目標(0.67〜2.7GB)未達。
→ **同次元サーフェス間で grid geometry + index を共有(refcount付き)する Phase C3 まで実装して初めて 17GB→~2.7GB(float)/~0.67GB(uint8) が成立。** C3 は「任意の最適化」でなく 4km×7枚目標の必須要件。

### 段階導入（1変更ずつ・コミット分割でbisect可能に）
- **C1（正しさのゲート）**: 1サーフェス、float32 height texture、手動グリッド、LUT-textureシェーダー。per-entry geometry。texture dispose + capability check。n18で**現mainとピクセル一致**を確認（inferno色/H/-40..0dB/透明床/colorbar/ticks/Expand/Full-Crop）。context-lost/restoreでtexture再アップロード確認。
- **C2**: Full/Crop toggle と Expand の検証。`setData`(Full↔Crop)で旧height texture破棄＝リークなし（VRAMをtoggle反復で監視）。
- **C3（メモリ勝利・必須）**: `${R}x${C}` キーのgeometryキャッシュ+refcount。同次元entryで1 PlaneGeometry/index共有。dispose はrefcount 0時のみ。**ここで 4km×7枚が 17GB→~2.7GB に落ちる**。手動OFFしてた n19/20/21 を全ON に戻せること確認。
- **C4（任意・後回し）**: uint8 height texture（~1N、payloadも1/4）。`UnsignedByteType`+正規化。0.39%(1/256)量子化、許容か確認。**Desktopルール「float32で忠実性確保してから」に従いC1-C3後**。

### 検証サイクル（frontend変更=npm build+Electron再起動必須）
1. `npm run build` → Electron再起動(ctl.py)
2. SARフロー実行(n18先頭)。**実行中はcanvas API送らない**(narratorポーリング、flow_completed後に編集)
3. **ピクセル比較**: 現main(リファクタ前=per-vertex)のスクショ vs C1ビルド、同フロー・同カメラ(sph既定 line139が決定的初期カメラ)→一致必須
4. **VRAM(CDP)計測**: 4km×7枚が12GB内、手動OFFの中間3D(n19/20/21)を再ONできること。初回表示/再実行の速度向上も実測
5. context-lost/restore(WEBGL_lose_context等)でtexture再アップロード・表示復帰確認
6. C1ピクセル比較ゲートで Claude Desktop に相談すると良い

### Planエージェントが挙げた罠（three.js固有）
1. vertex texture fetch可用性（WebGL2=r160既定でOK、WebGL1はcapability checkでエラー明示・黙フォールバック禁止）
2. DataTexture `flipY` 既定false（画像textureと逆。最有力のC1バグ＝上下反転、1行修正）
3. off-by-half-texel（必ずテクセル中心UV）
4. **NEAREST必須**（height/LUT両方。Linearは忠実性破壊＝最重要）
5. PlaneGeometry頂点/UV順序の罠（C1は手動グリッドで回避、C3でPlaneGeometry検討）
6. `vertexColors:true` 削除し忘れ（color属性無しで警告/誤動作）
7. **float texture VRAM=4N、index(24N)がC3まで支配的** → C3必須（上記）
8. NaN処理パリティ（`vT!=vT→0`）
9. シェーダーコンパイル失敗はサイレント気味（コンソール/errorCallbacksで明示）

---

## 13. 【方式C の結末 — texture方式は環境的に不可。属性方式(44N/8%減)も「割に合わない最適化」として revert（2026-05-24）】

### 一行サマリ（最新の結末）
**方式C（height を GPUテクスチャ化し頂点シェーダーで変位）は、この Electron/ANGLE 環境では頂点シェーダーのテクスチャフェッチが動かず不可能だった（実測確定、下記）。代替として height を uv.x 属性で渡す方式（48N→44N）を実装しピクセル一致まで確認したが、8%しか減らないのに custom shader / uv-as-height / LUT texture という複雑さだけが残る「割に合わない最適化」だったため、ユーザー判断で revert（commit a41badd）。現在は素直な per-vertex pos+col+index=48N に戻っている。**

**ただし以下の実測知見と次の一手（案2/案3）は将来のために残す（ユーザー指示「コードは戻す、知見はドキュメントに残す」）。**

### この知見の最重要点（将来の再挑戦防止）
- **この Electron/ANGLE では頂点テクスチャフェッチが動かない** → height を GPU texture 化して頂点段で読む方式（§11/§12 が狙った 98%減/~0.67GB）は**原理的に不可能**。再挑戦するな。
- **割に合う削減の道 = 案2(pos を gl_VertexID 生成、頂点テクスチャ不要なので動くはず・要実測)→28N + 案3(index 同次元共有)→現実的下限 ~1.2GB**。やるならここまで一気に（中途半端な属性方式8%は revert 済み）。
- color のフラグメント LUT 化自体は妥当だったが、単独では意味が薄いので per-vertex color に戻した。

### 何が起きたか（実測の経緯）
§12 計画通り `_rebuildMesh` を「固定グリッド + height DataTexture(float32, RedFormat) + 頂点シェーダーで `texture2DLod(uHeightTex, uv).r` で高さ読み + フラグメントで inferno LUT」に書き換え、ビルド・再起動・実行 → **3D表示が真っ平ら（サーフェスが見えない）**。
切り分け（推測せず実測、CDP多用）:
1. シェーダーは生WebGL2で正常コンパイル（texture2DLod/texture2D/textureLod 全部OK）→ シェーダー構文は無実。
2. `_debugDump`(window.__surfMgr露出)で mesh/geometry/index/boundingSphere/camera 全て正常、`field` にデータあり(fieldMax=0.666)→ ジオメトリ/カメラ/データは無実。
3. デバッグfragmentで discard 外し+vT可視化 → **それでも見えない**＝fragment到達せず＝メッシュがラスタライズされていない。
4. 頂点シェーダーを `float t = uv.x;`(texture不使用)に → **斜面が正常描画**＝ジオメトリ/index/カメラ/material/drawImage全部正常、**texture頂点フェッチだけが死んでいる**と確定。
5. CDP生WebGL2 probe で決定打: **フラグメント段のテクスチャサンプリングは R32F/R8 とも完璧(readPixels=[64,191])、頂点段(transform feedback)は R32F/R16F/R8 全部 drawErr=1282(INVALID_OPERATION), sampled=[0,0]**。three本番経路で uint8 height texture も試したが同じく平面。→ **この ANGLE コンテキストは頂点テクスチャフェッチ不可**（`MAX_VERTEX_TEXTURE_IMAGE_UNITS=16` と報告するのに実際は動かない）と最終確定。

§11/§12 と Plan の大前提「three r160=WebGL2なら頂点テクスチャフェッチOK」は **この環境では成り立たない**。これが設計の中核を崩した。

### 転換後の実装（= 現在の `SurfaceRendererManager.ts`）
- **height t を頂点 uv.x 属性で渡す**（カスタム属性 `aT` も試したが、リンク後のプログラムのアクティブ属性に現れず `getAttribLocation('aT')=-1` だった＝three r160 の ShaderMaterial でカスタム属性が効かない別の罠。組み込み `uv` は確実にバインドされるので uv.x に t、uv.y=0）。
- 頂点シェーダー: `float t = uv.x; p.y = t*uH; vT=t;`。フラグメント: `t→inferno LUT テクスチャ`（**フラグメントのテクスチャフェッチは動く**）+ 透明床 `if(l<0.06)discard`。NaN→0 もシェーダーで再現。
- geometry: pos(12N, y=0平面)+uv(8N, .xにt)+index(24N) = **44N**（旧 pos+col+index=48N から **color 12N をフラグメント化**、uv 8N 追加で実質 -4N）。LUT は 256×1 RGBA float DataTexture を1個共有（RGBFormat は r160で削除→RGBA展開）。
- 32bit index 用に WebGL2 or OES_element_index_uint を capability check（無ければ赤エラー、no silent fallback）。
- context-restore は entry.data.field から `_rebuildMesh` で再構築（既存機構そのまま）。

### 忠実性検証（PASS）
git stash で旧版(per-vertex, HEAD 2aee66a)に戻してビルド・実行し、新旧で n27(raw echo, 連続形状)を同一ビュー(fit_node)で撮影 → **形状・inferno色・透明床・軸/colorbar/トグル全てピクセル一致**。属性方式は pos の y を CPU で焼く代わりにシェーダーで t*H 変位、color をフラグメントで LUT 参照しているだけで**最終頂点位置と色は数学的に同一**。n18 焦点画像は Full では平坦に見えるが Crop で鋭いインパルスピークが立体表示＝データ正常(焦点画像は「ほぼ0+鋭いピーク」が正しい姿)。

### メモリ削減の実数（§11の「~4N/0.67GB」は達成不可、訂正）
| 方式 | バイト/頂点 | 4km1プロット | 4km×7枚 | 可否 |
|---|---|---|---|---|
| 旧 GL(pos+col+idx) | 48N | 2430MB | 17GB | （元） |
| **属性方式(pos+uv+idx) ← 現状** | **44N** | ~2228MB | ~15.6GB | **動作・忠実** |
| texture方式(§11が狙った) | ~4N | ~95MB | ~0.67GB | **❌ 頂点texfetch不可で実現不能** |

**現状の削減は 48N→44N=8.3%減のみ**（color をフラグメント化した分。pos/index は頂点テクスチャ使えないので消せない）。§11 が謳った 98%減（~0.67GB）は **この環境では原理的に不可能**。

### さらなる削減の候補（未実装、要設計判断）
- **案2: pos を gl_VertexID から生成**（grid寸法 C,R を uniform で渡し `c=id%C, r=id/C`, `x=c*invC-1, z=r*invR-1`）→ position 属性廃止。t は uv.x のまま or 1成分attr。28N相当。**頂点テクスチャ不要なので動くはず**（gl_VertexID は WebGL2 標準）。
- **案3: index を同次元サーフェス間で共有**（refcount）→ per-entry は t(uv 8N or 1成分4N)のみ、index 1個共有。4km×7枚で t≈7×190MB + 共有index 570MB ≈ **1.9GB**（uv 8N）/ t を1成分4N化できれば ~1.2GB。**属性方式での現実的下限**。
- 案2+案3 併用が最小。ただし「カスタム属性が効かない」罠を解く必要（gl_VertexID 生成なら属性自体を減らせる）。

### 次にやること
1. **この実装をコミット**（現在未コミット。デバッグコード除去済み・型ベースライン不変・ビルドOK・runtime0エラー・忠実性PASS）。
2. ユーザーに設計転換を報告（texture不可→属性方式、メモリ削減は8%に留まる、さらなる削減は案2/案3が必要）。**4km×7枚を本当に12GBに収めたいなら案3が要る**。
3. 中間プロット(n19/20/21)の手動OFF状態は属性方式では大きく改善しない(44N≈48N)。案3まで実装して初めて全ON可能になる見込み。

### 関連ファイル / tmp（このセッションで作成、コミット前に整理）
- 本実装: `frontend/js/components/SurfaceRendererManager.ts`（_rebuildMesh, シェーダー, capability check）。
- tmp_cdp_*.py（probe/dump/floattex/texfmt/fragsample/attrs/click）= CDP実測スクリプト群。再利用価値あるが .gitignore 対象 or 削除。
- tmp_baseline_pervertex.png / tmp_new_n27.png / tmp_old_n27.png = 忠実性比較画像。
- メモリノート: [[project-sar-method-c-vertex-texfetch]]

---

## 14. 【案A 実装完了 — gl_VertexID position生成 + uv.x height + 共有index（2026-05-24）】

§13 で revert して 48N に戻した後、ユーザー指示で**案Aを実装**。`SurfaceRendererManager.ts` 1ファイルのみ変更。

### 設計（実装済み）
per-vertex の pos(12N)+col(12N) 属性を**全廃**:
- **position は頂点シェーダーで `gl_VertexID` から生成**。indexed draw では **`gl_VertexID` = index要素値 = flat k = r*C+c**（0..N-1の連番ではない＝重要）。シェーダーで `c=k%uC`(`k-(k/uC)*uC`で実装), `r=k/uC`, `x=(uC>1)?c*invC-1:0`, `z=(uR>1)?r*invR-1:0`, `y=t*uH`。invC/invR/uH/uC/uR は uniform。**旧CPU式と完全一致**。
- **height t は uv.x 属性**（uv.y=0未使用）。カスタム属性 `aT` は r160 ShaderMaterial でバインドされなかった（§13）が組み込み uv は確実に動く。
- **color はフラグメントで inferno LUT テクスチャ**（256×1 RGBA float, NEAREST。r160 は RGBFormat 削除済→RGBA展開）。`idx=floor(clamp(t)*255+0.5)`, `u=(idx+0.5)/256`。**フラグメント段の texfetch は動く**（頂点段は不可、§13）。透明床 `l<0.06 discard`・NaN→0 も再現。
- **index は同次元(R,C)で共有**: `acquireIndex(T,R,C)`/`releaseIndex(T,R,C)` が `${R}x${C}` キーの refcount付きキャッシュ。同次元サーフェスは1つの index BufferAttribute を共有。

### 実装上の必須ポイント（罠）
1. **`mesh.frustumCulled = false` 必須**。position属性が無い→three が boundingSphere を計算できない→カリングでメッシュが消える。設定しないと真っ黒になる。
2. **ShaderMaterial を使う（RawShaderMaterial でない）**。three が WebGL2 で GLSL1→GLSL3 変換し `gl_VertexID` を注入する（`WebGLProgram.js:856-868` で確認）。RawShaderMaterial だと自分で `#version 300 es` を書く必要があり gl_VertexID も未定義になる。
3. **共有 index の dispose**: `geometry.dispose()` は共有 index の GL buffer も解放してしまう→他エントリが壊れる。**`geometry.setIndex(null)` で detach してから dispose**、refcount 0 で初めて使い捨て geometry 経由で GL buffer 解放（`releaseIndex`）。`_rebuildMesh` 先頭の旧mesh破棄と `_disposeEntryGPU` の両方で detach+release。
4. **context-loss**: `lutTexture=null` + `indexCache.clear()`。restore の `_rebuildMesh` ループが lazy 再構築。release が clear済みキーに当たっても no-op で安全。
5. uniform `uC`/`uR` は GLSL `int`（整数除算・剰余に必要）。three は linked program の active uniform 型から `uniform1i` を選ぶので JS は整数 number を渡せばよい。

### 検証（全PASS、CDP/スクショ実測）
- **メモリ**: `_debugMem`(一時露出, 検証後削除) で現フロー3エントリ(240²+2460×9844×2)を実測 → **pos/color属性ゼロ**、**index は2460×9844の2エントリで refcount=2 共有**(uniqueIndexBuffers=2種)、uv 369.9MB + 共有index 555.3MB = **925MB**。旧48N同構成 ~2327MB に対し **約60%減**。同次元プロットが増えるほど共有が効く。
- **忠実性**: git stash で per-vertex(48N) に戻して n27 を同一ビュー撮影→**Plan A とピクセル一致**（gl_VertexID で同じ式・同じLUT なので数学的に同一）。n18 Crop も鋭いピーク正常。
- runtime 0エラー、Full/Cropトグル後も0エラー（共有index dispose/release がリーク・クラッシュなし）。型ベースライン19不変、build OK。

### さらなる削減（任意・未実装）
- height を1成分カスタム属性(4N)にできれば uv(8N)→4N。ただし `aT` バインド失敗の罠の解明要。
- height を uint8/half 化は頂点属性の最小粒度（4byte/float成分）と相性悪く効果薄。
- 現状60%減で n19/20/21 を ON に戻せる余地が増えた（要VRAM実測で確認）。

### コミット
（このセッションでコミット。§13までの knowledge は維持、コードは案A）。
