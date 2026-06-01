# 引き継ぎ — SAR エコー合成 FPGA データパス（Vivado/ZCU111）2026-05-31

**ブランチ** main / **最新コミット** `54a7deb`（origin/main 反映済み）
関連メモリ: `fpga-echo-datapath`（要点）, `fpga-range-fft-nr-pow2`, `msys2-verilator-setup`

## 🏆 達成済み（このセッション、すべて main に push 済み）

SAR の **反射波模擬（エコー合成 = HIL ターゲットシミュレータ）** FPGA データパスを、設計→sim検証→ランタイムN化→**実機 ZCU111 でビット精度実証**まで完成。

**⚠️ これはレンジ圧縮ではない。** `s_raw = IFFT( FFT(fir) × chirp_fft )`、係数は **forward** chirp_fft（共役なし＝畳み込み＝エコー生成）。レンジ圧縮（整合フィルタ＝共役）は SAR 処理の下流の別ステージ（HiyoCanvas n14）で、この FPGA とは別物。

**全段ビット一致（独立再確認済み）**:
```
Python(route_vivado_ip) ≡ FFT IP C-model ≡ xsim(実機RTL) ≡ 実機 ZCU111 silicon
```
N=1024 自己診断: s_raw 1024/1024 一致, max code diff 0, be_inv=4 一致。

### コミット履歴（このセッション、新しい順）
- `54a7deb` 実機自己診断（echo_selftest, ZCU111 で bit-exact）
- `ac5d643` ランタイムN化データパス + 250MHz XDC
- `6fd3b4c` エコー合成データパス RTL（xsim bit-exact）
- `c508649` xsim TB（xfft IP == C-model 実証）
- `9c124a9` vivado-bridge スキル追加
- `a609cdd` FFT IP C-model 検証ルート（FPGA4 n64）
- （前半）`8b122de` Nr→pow2, fidelity, SPEC修正, old/ アーカイブ 等

## 構成と検証チェーン

**Vivado プロジェクト**: `workspace-SAR-SIM/vivado/fft_test`（part **xczu28dr-ffvg1517-2-e**, board **zcu111 1.4**, Vivado **2021.2**）。**`vivado/` は gitignore 済み**（数GB）。再生成レシピ = `workspace-SAR-SIM/vivado_recipe/create_project.tcl` + `xfft_0.xci`（※ clk_wiz_0/vio_0/cmpy_0 の .xci はまだレシピ未収録 — 要再エクスポート）。

**IP（単一 generics = 実機とC-model共通）**:
- xfft v9.1: `pipelined_streaming_io` / `run_time_configurable_transform_length` / `transform_length 65536` / input・phase **16bit** / `block_floating_point` / `truncation` / `natural_order` / 1ch。
- cmpy v6.0: APort/BPort 16, OutputWidth 33, **Truncate**（16×16→33 厳密整数積）。
- clk_wiz_0: User SI570 差動 300MHz（工場デフォルトで自走, I2C不要, pin J19/J18 DIFF_SSTL12）→ aclk **250MHz**。vio_0, ILA(depth2048)。

**キーファイル（git管理, `workspace-SAR-SIM/`）**:
| ファイル | 役割 |
|---------|------|
| `scripts/xfft_cmodel.py` | xfft IP **bit-accurate C-model** の ctypes バインド。回復 `y*2^(+blk_exp)`、IFFT 非正規化(=ifft·N)。バイナリは `scripts/xfft_cmodel/`（Xilinxライセンス, **gitignore**） |
| `scripts/model_echo_datapath.py` | **HW忠実な整数/コード域モデル**（bit一致の真実）。`echo_datapath(fir,ref_chirp,N)` |
| `scripts/xfft_route.py` | `route_vivado_ip`（HiyoCanvas FPGA4 の n64 "vivado" ルートが使用） |
| `scripts/gen_echo_vectors_rt.py` | per-N テストベクトル生成 |
| `hdl/echo_datapath_rt.sv` | **ランタイムN本体**（nfft_sel/shift_sel 実行時, 係数BRAM書込可, NMAX=65536, FFT→cmpy→33→16shift→IFFT） |
| `hdl/echo_selftest.sv`(+.xdc, .mem×2) | **実機自己診断**（clk_wiz→aclk, BRAM入力, VIO start, ILA捕捉） |
| `hdl/echo_datapath.sv`, `tb_*.sv`, `echo_timing.xdc`, `echo_stage1.sv` | 固定N版・各TB・250MHz制約・bring-up scaffold |

## リソース/タイミング（echo_datapath synth, xczu28dr）
15.8k LUT / 21.9k FF / **395 BRAM (36.6%)** / 59 DSP / URAM 0。impl **WNS -0.014ns @250MHz**（14ps僅か未達, 機能無影響, クリーン閉路は ~200-240MHz）。**N拡張余地大**: 律速BRAM、2倍規模でも~73%＋URAM80転用可。65536超は multi-pass 分解。

## 新セッションでの再開手順
1. **Vivado を起動**し、Tcl Console で:
   `source d:/kamijo/HiyoCanvas/.claude/skills/vivado-bridge/vivado_socket_server.tcl`
   → `python d:/kamijo/HiyoCanvas/.claude/skills/vivado-bridge/scripts/connection_check.py` で疎通確認。
2. プロジェクト `fft_test` を開く（閉じていれば vivado_recipe から再生成 or 直接開く）。**ボードは self-test ビットストリームでプログラム済みの可能性**（DONE high のまま）。
3. HiyoCanvas 側: FPGA4 フローの `route_mode` ドロップダウンに `vivado`（n64）。実行すると `route_vivado_ip`（C-model）で s_raw 生成。
4. 検証再現: `.venv\Scripts\python.exe workspace-SAR-SIM/scripts/test_xfft_cmodel.py` 等。

## 次の候補（優先度は要相談）
1. **実HIL統合**（本命）: RFSoC ADC/DAC 接続、PS/AXI で係数を実行時ロード、連続パルス処理 → 本物の radar-in-the-loop。
2. **>65536 分解**: multi-pass FFT。
3. **タイミング クリーン閉路**: aclk を ~240MHz に下げる（14ps未達解消）。
4. **vivado_recipe 再エクスポート**: clk_wiz_0/vio_0/cmpy_0 の .xci を含め再現性向上（`export_project.py`）。
5. **HiyoCanvas 統合**: FPGA を SAR フローの実エコー源として HIL ループに。

## Gotchas（重要）
- **Vivado Synthesis ライセンスは期限切れ→更新済み**（xczu28dr は要ライセンス）。再度切れたら synth/impl がブロック（sim は不要）。
- **vivado-bridge スキル**で Vivado を駆動（`.claude/skills/vivado-bridge/`）。`exec_tcl.py` の出力は最後の式の戻り値。長時間 op は launch→poll（client timeout 120s）。`warnings` を毎回読む（RESULT/エラーはそこに出る）。
- **C-model 規約**: 出力は生バス値、真値 = `y * 2^(+blk_exp)`（プラス）。IFFT は非正規化（= np.fft.ifft·N、1/N したいなら ÷N）。
- **xfft config 語**: `(FWD_INV<<8)|NFFT`、NFFT=log2(N) bits[4:0]（fwd=1, inv=0）。data tdata = `{im16, re16}` Q1.15。BFP の blk_exp は m_axis_data_tuser[7:0]。
- **cmpy** は NonBlocking 固定レイテンシ（tready/tlast 無し）→ 出力をバッファしてから IFFT に渡す。
- **ランタイムN の罠**（修正済, 再発注意）: 逆FFT config はフレーム境界(pq_full立上り)で送る／逆ストリーマは done-latch で1フレーム1回だけ（buffer-full レベルだけで起動すると毎フレーム再ストリームする）。
- `vivado/` は gitignore。`old/` に旧 .rcflow をアーカイブ済み。`.env` は repo root の .gitignore で除外（host/port デフォルトで動く）。
- HiyoCanvas 操作中はフロー実行中に canvas API を送らない（レンダラークラッシュ）。コード編集後は **save_tab**（再起動で消える）。
