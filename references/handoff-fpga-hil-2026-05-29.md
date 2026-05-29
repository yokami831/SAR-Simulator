# 引継ぎ — FPGA HIL: Amaranth FFT + Verilator パイプライン

**日付**: 2026-05-29
**ブランチ**: `main` (= `origin/main` = `ec1203d`)
**前提**: ローカル `d:\kamijo\HiyoCanvas`、Remote `origin = yokami831/SAR-Simulator`、`upstream = manahiyo831/HiyoCanvas` (fetch 専用)

## このセッションで完了したこと

### 1. upstream 取り込み (装飾 + Node UI)
- `744d90d / 4abfdb8 / 4858f87` (comment block 機能拡張 = frame 兼用、style popup、Transparent ボタン)
- `9bd873e` (ネオンパレット + 6px サイドバー + gradient edges + 個別 barColor)
- 副産物: `a4a06cd fix(useFlowPersistence)` — upstream の barColor が `.rcflow` に保存されないバグを発見し修正

### 2. Bar 色割り当て (`SAR-Simulator-FPGA2`)
| ノード | 色 | 役割 |
|--------|----|----|
| n54 sar_visualizer | 黄 #facc15 | 特殊（フルフロー パラメータソース） |
| n26 / n52 / n53 / n55 / n59 | 蛍光緑 #a3e635 | GUI 入力群 |
| n18-21 / n27 / n31 / n41 / n58 | オレンジ #f59e0b | プロット / 表示系 |

### 3. HIL Stub インフラ
- `FPGA-HIL-Stub.rcflow` (新規タブ) — 入力 .npz → Load → FPGA Compute → Save → 出力 .npy
- `SAR-Simulator-FPGA3.rcflow` (新規) — Route C-out (n44) を `.mat` → `.npz` (`np.savez`) に変更、n59 fpga_config のパスデフォルトを `fpga_io/` に
- `workspace-SAR-SIM/fpga_io/` — HIL 境界ディレクトリ (`.gitignore` で `fpga_io/*` 除外、`.gitkeep` は保持)

### 4. Amaranth FFT + Verilator パイプライン ⭐ 本セッションの目玉

`workspace-SAR-SIM/scripts/` に格納:
- `amaranth_seq_fft.py` — `SeqFFT(N, W_IN)` パラメータ化 radix-2 DIT FFT (シーケンシャル単体バタフライ、in-place RAM、Q1.15 入力 / Q1.15 ツイドル / Q(1+log2(N)).15 内部)
- `amaranth_fft8_poc.py` — 初期 8 点 unrolled PoC (履歴として保存)
- `tb_seq_fft.cpp` — Verilator C++ ハーネス、stdin/stdout バイナリ I/O、**バッチモード** (stdin EOF まで複数フレーム処理)
- `verilator_fft_drive.py` — エクスポート + Verilator 実行 + Python 駆動。`run_fft_batch()` で複数行を 1 プロセスで処理
- `verilator_route_b.py` — Route B 完全相当: `verilator_fft` / `verilator_ifft` / `route_b_pipeline()` (Stage A/B/C Q-format 量子化 + BFP)
- `bench_batch.py` — スループット計測スクリプト
- `README.md` — セットアップ手順 + パイプライン図 + 性能表

### 性能
| シミュレータ | N=8192 1FFT | 2016 行 SAR フル HIL |
|------------|-----------|---------------------|
| Amaranth pysim | 10.7 s | ~6 時間 |
| Verilator single | 187 ms | ~6 分 |
| **Verilator batch** | **8.77 ms 実効** | **17.7 秒** |

→ pysim 比 **1200×** 高速化。SNR は全構成で ~68 dB (Q1.15 ツイドル限界)。

## 重要な技術的事項 (Critical Gotchas)

### Windows での Verilator は MSYS2 bash 経由必須
- Verilator 5.048 を MSYS2 (`C:\msys64\mingw64\bin\verilator`) にインストール済み
- Windows ネイティブ Python から直接 perl 経由で叩くと `/mingw64/...` パスが解決されない
- `verilator_fft_drive.py` の `_patched_execute_cmds` 相当の処理で **`bash -lc "verilator ..."`** に変換する
- 同様に `make` も bash 経由 (MSYS2 の `make` パッケージは `/usr/bin/make.exe`)

### cocotb は使わなかった
- cocotb の Windows wheel に Verilator VPI ライブラリ (`cocotbvpi_verilator.dll`) が含まれていない
- ソースからのビルドは MSVC が必要で MinGW では通らない
- **回避策**: cocotb スキップ、直接 C++ テストベンチ + stdin/stdout バイナリ I/O で実装

### barColor 保存バグ
- `useFlowPersistence.ts` で `node.data.barColor` が serializer のホワイトリストから漏れて保存されない
- `a4a06cd` で修正済み (`save` と `restore` 両方)

### tmp/ vs workspace-SAR-SIM/scripts/
- `tmp/` は `.gitignore` 対象 (SKILL ワークフロー用一時ファイル)
- 永続化したいスクリプトは `workspace-SAR-SIM/scripts/` に移動済み
- `fpga_io/` も gitignored (HIL 中間データ、`.gitkeep` だけ git 追跡)

## 現状のフロー

### `SAR-Simulator-FPGA3.rcflow` (現メイン作業フロー)
35 ノード、Route A/B/C-out/C-in を持つ。デフォルト Enable は Route B (cupy 量子化)。
- n42 Route A (Float Ideal IFFT) — DISABLED
- n43 Route B (Fixed-point Q-format 3-stage) — ENABLED (現状) ← cupy GPU 量子化、~0.1s/フレーム
- n44 Route C-out (Save Coefficients .npz) — DISABLED
- n47 Route C-in (Load FPGA IQ .npy) — DISABLED
- n54 sar_visualizer / n55 image_target_config / n59 fpga_config (GUI 統合)

### `FPGA-HIL-Stub.rcflow` (HIL 検証フロー)
5+1 ノード:
- n1/n2 gui_file_picker (入力 .npz / 出力 .npy パス、デフォルトで `fpga_io/coeffs.npz` / `fpga_io/fpga_out.npy`)
- n3 Load Coefficients (np.load で kernel に展開)
- n4 FPGA Compute (cupy mirror of Route B) — **enabled (default)**
- n5 Save FPGA IQ (np.save)
- n6 FPGA Compute (Verilator HIL) — **disabled (default)**、紫バー、route_b_pipeline 使用

### 典型 HIL ワークフロー
```
1. FPGA3 で Route A + Route C-out を ON 実行 → coeffs.npz (golden 入り)
2. HIL-Stub で n4 OFF / n6 ON、実行 (~18秒) → fpga_out.npy
3. FPGA3 で Route A/B OFF / Route C-in ON 実行 → bit-exact HIL SLC 画像
4. Route A の golden 画像と比較して量子化誤差・実装誤差を評価
```

## 動作確認方法 (次セッションで最初にやること)

### 環境動作確認
```powershell
# Verilator が動くか (MSYS2 経由)
C:\msys64\mingw64\bin\verilator --version  # → 5.048

# Amaranth + Verilator パイプラインのスモークテスト
d:\kamijo\HiyoCanvas\.venv\Scripts\python.exe d:\kamijo\HiyoCanvas\workspace-SAR-SIM\scripts\verilator_route_b.py 1024 8
# 期待: verilator_fft SNR ~73 dB, ifft round-trip ~69 dB

# バッチスループット
d:\kamijo\HiyoCanvas\.venv\Scripts\python.exe d:\kamijo\HiyoCanvas\workspace-SAR-SIM\scripts\bench_batch.py
# 期待: N=8192 Na=2016 で 17.7 秒
```

### HIL 統合の未完了テスト
**Phase D/E のエンドツーエンドテストはまだ未実行**:
- FPGA3 で Route A + C-out を実行して `coeffs.npz` を実際に生成
- HIL-Stub で n6 (Verilator) を enable、n4 (cupy) を disable、実行
- 出力 `fpga_out.npy` を FPGA3 の Route C-in で読み込んで SLC 画像化
- Route A の golden と比較

最も検証価値が高いのはここ。実 SAR データ (Nr=4036, Na=2016) で n6 が ~18 秒で完走するか、SLC 画像が想定通り出るか確認。

## 今後の予定 (優先順)

### 高優先 (引き続きやるなら)
1. **HIL エンドツーエンド検証** — 上記未完了テストを実行
2. **HIL 自動回帰テスト** — `bench_batch.py` を拡張、Route A の cupy 結果と n6 Verilator 結果の差分 (PSF / SLC 画像 / SNR) を自動チェック
3. **Q-format パラメータ探索** — n6 の Q_IN/Q_FFT/Q_OUT を変えて画質劣化点を定量化 (CLAUDE.md の SAR n32 = 4 ノード「FPGA 3 ルート」構成セクション参照、Stage B Q4.4 / Q3.3 等まで攻めて画質崩壊点見つける)

### 中優先 (時間あれば)
4. **Amaranth FFT を pipelined streaming 化** — 現状は単体バタフライでサイクル数 ~3×N/2×log2(N)、リアルタイム不可。Radix-2² SDF 等で 1 sample/cycle にすれば実 FPGA リアルタイム可能 (CLAUDE.md FPGA HIL セクション参照)
5. **ZipCPU dblclockfft 統合** — 既にクローン済の Verilog FFT を Verilator で動かす。pipelined streaming の即戦力
6. **FPGA 実機展開** — Pynq-Z1 等のボードで Verilog 合成 → ビット幅検証

### 低優先 (アイデアレベル)
7. **CXXRTL 移行検討** — Amaranth `back.cxxrtl` で Verilator なしの C++ 直接生成 (現状は Simulator API から engine="cxxrtl" 指定はまだサポートされていない、将来的に有望)
8. **Notes / Excalidraw タブで HIL の設計文書化**

## 重要ファイル早見表

```
workspace-SAR-SIM/
├── SAR-Simulator-FPGA3.rcflow     # 現メイン作業フロー
├── FPGA-HIL-Stub.rcflow            # HIL 検証フロー
├── SAR-Simulator-FPGA2.rcflow      # 旧版 (FPGA3 のソース)
├── blocks/
│   ├── sar_visualizer.json         # 3D 衛星可視化ブロック
│   ├── image_target_config.json    # 画像/点ターゲット GUI 統合
│   └── fpga_config.json            # FPGA Route GUI 統合
├── fpga_io/                        # gitignored, HIL 中間データ
│   ├── coeffs.npz                  # Route C-out 出力
│   ├── fpga_out.npy                # HIL-Stub 出力
│   └── vbuild_<N>/                 # Verilator ビルド成果物 (キャッシュ)
└── scripts/                        # 永続化、git tracked
    ├── README.md                   # セットアップ + 使用法 + 性能表
    ├── amaranth_seq_fft.py         # FFT HDL 本体
    ├── amaranth_fft8_poc.py        # 履歴: 8点 unrolled PoC
    ├── tb_seq_fft.cpp              # Verilator C++ ハーネス (バッチ)
    ├── verilator_fft_drive.py      # Python ドライバ (export → build → run)
    ├── verilator_route_b.py        # Route B Stage A/B/C 完全相当
    └── bench_batch.py              # スループット計測

CLAUDE.md
└── "FPGA HIL: Amaranth FFT + Verilator pipeline" セクション (恒久)
```

## 関連コマンド

```powershell
# HiyoCanvas 起動/停止
.venv\Scripts\python.exe .claude\skills\hiyocanvas-bridge\scripts\ctl.py start
.venv\Scripts\python.exe .claude\skills\hiyocanvas-bridge\scripts\ctl.py stop

# canvas API
$API = "d:\kamijo\HiyoCanvas\.venv\Scripts\python.exe d:\kamijo\HiyoCanvas\.claude\skills\hiyocanvas\scripts\canvas_api.py"
& $API get_tabs
'{"node_id":"n6","enabled":true}' | & $API update_element

# Verilator HIL FFT 単体テスト
.venv\Scripts\python.exe workspace-SAR-SIM\scripts\verilator_fft_drive.py 8192      # 単発
.venv\Scripts\python.exe workspace-SAR-SIM\scripts\bench_batch.py                    # バッチ
.venv\Scripts\python.exe workspace-SAR-SIM\scripts\verilator_route_b.py 1024 8       # FFT/IFFT 往復テスト

# git
git fetch upstream                  # manahiyo831 から取り込みたい時
git log upstream/main..HEAD --left-right --oneline  # divergence 確認
```
