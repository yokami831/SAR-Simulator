# 引き継ぎ — SAR FPGA ルート / レンジFFT長 (2026-05-29 夜)

> ## ✅ 解決済み（2026-05-29 続きのセッション, commit `8b122de`）
> 下記「未解決の本丸」は **解決**。n2 の Nr を **next_pow2** に変更（4035→4096）し、
> NUFFT・echo合成・レンジ圧縮・HDL を全段 同一巡回長 Nr で一貫させた。HDL の
> `route_b_pipeline` は内部 next_pow2(Nr)==Nr で純粋巡回 Nr に退化 → float/fixed と
> 一致（継ぎ目消失）。線形/N_req/N_HDL/[:Nr]切出しは全撤去。**3ルート（float/fixed/hdl）
> 実機検証で画像・ポイント両方が全体表示・継ぎ目なしを確認済み**。ハードコードなし
> （Fs/R_half/Tp から自動追従）。
>
> 検証中に Verilator が `rc=127`（空出力）で死ぬ環境バグも発見・恒久修正:
> `bash -lc "verilator"` は `MSYSTEM=MINGW64` のときだけ `/mingw64/bin` を PATH に
> 載せる。Electron が spawn する kernel は MSYSTEM 未設定なので verilator が見つから
> なかった。`verilator_fft_drive.py` に `_mingw_env()` を追加し build/exe-run 両
> subprocess へ MSYSTEM=MINGW64 + mingw64/usr bin を渡して解決。
>
> **N 可変の整理**: FFTサンプル数(Nr=pow2)が変わると **Verilator シミュは自動追従**
> （`vbuild_{N}` を N ごとにビルド・キャッシュ、SeqFFT は N 完全パラメータ化）。**実機
> FPGA は合成時 N 固定なので再合成が必要**。Nr が同じ pow2 のままなら双方リビルド不要。
> 詳細メモリ: [[fpga-range-fft-nr-pow2]] / [[msys2-verilator-setup]]。
> 以下は当時の作業ログ（参考）。

**ブランチ** main / **最新コミット** `8b122de`（旧 `0c3bdba` 時点の引き継ぎ）
対象フロー: `workspace-SAR-SIM/SAR-Simulator-FPGA3.rcflow`（アクティブ作業フロー）

## このセッションで完了したこと（コミット済み・有効）

1. **ドロップダウン route_mode（float/fixed/hdl 切替）** — n61。3ルート(n42/n43/n62)は全て enabled で、各自が `if route_mode==...` で自分の時だけ s_raw 計算。排他保証（後勝ち事故が起きない）。enable/disable 不要。
2. **単一ソース Q-format（n60）** + npz meta 伝搬（HIL-Stub へ）。Q_IN=(8,7)/Q_FFT=(10,4)/Q_OUT=(8,7)。
3. **実装可能な固定小数点（n43 + verilator_route_b.py）**: Stage B/C を **per-scene 2べきビットシフト**（`shift=floor(log2(0.95*FS/peak))`、host が既知係数から計算して FPGA に渡すパラメータ）。`quantize_bfp` が pow2 シフト + 飽和。これは正しい・残す。
4. **HDL = Verilator ゲートレベル一致確認済み**: 同じ pow2 FFT 長・同じ shift なら Python固定小数点 ≈ HDL が **SNR ~45dB, assert_allclose PASS**（スタンドアロン検証 `tmp/verify_pow2.py`）。
5. **軸スケールは正常**（バグなし）: range≈2.08m/sample(c/2Fs), az≈1.90m/sample(V/PRF) が偶然どちらも約2m。分解能 c/2B=2.5m, La/2=2.4m は別概念。エージェント確認済み。

## ⚠️ 未解決の本丸（次セッションのメイン作業）

### 問題: HDL の継ぎ目 / 画像が半分
- 現フロー: float/fixed は **巡回畳み込み Nr=4036**（revert済み・動く＝全体画像）。HDL(route_b_pipeline) は **radix-2 で pow2(4096)にパディング** → 4096-巡回 と 4036 のズレで**中央に継ぎ目**。
- 私が一度 float/fixed の echo を「8192線形 + [:Nr]切出し」にしたら **画像が半分**になった（commit 327fa90）。原因: ref_chirp が中央(Nr//2)配置のため線形畳み込みで各エコーが +Nr//2 ずれ、遠方が Nr 超で切り落とされる。→ `0c3bdba` で巡回 Nr に revert 済み（線形は撤回）。

### 診断（動いていた `workspace-SAR-SIM/TargetSim_old/TargetSim_GPU_strix_good.rcflow` との比較）
- strix_good は **echo合成(n9)も圧縮(n12)も全段 Nr の巡回畳み込み**。chirp は配列**先頭**配置。**HDLルート無し**→pow2制約なし。だから巡回 Nr で完結し全体画像が出る（合成側の巻き込みを圧縮側が同じ Nr でキャンセル）。
- FPGA3 も OLD は巡回 Nr で動いていた。**線形化は HDL(radix-2) のために導入したが不要だった。**

### ★推奨する本当の解 ＝ **Nr 自体を 2のべき乗にする**
`backend`... ではなく **n2 (Generate chirp signal)** の Nr 計算を変える:
```python
# 現状: Nr = int(np.ceil(2 * t_r_half_window / dt_r)); Nr += Nr % 2   # 偶数丸め -> 4036
# 解:   _nr0 = int(np.ceil(2 * t_r_half_window / dt_r)); Nr = 1 << (_nr0 - 1).bit_length()  # next_pow2 -> 4096
```
これだけで:
- NUFFT(n32)・echo合成(n42/n43/n62)・レンジ圧縮(n14)・HDL が**全部 Nr=4096 の巡回で一貫** → strix_old と同じく全体画像、かつ HDL(radix-2) は Nr=4096 がそのまま pow2 なので**追加パディング不要・継ぎ目なし** → float/fixed/hdl 一致。
- 線形/N_req/N_HDL/[:Nr]切出しの複雑さは**全て不要・撤去**。
- パラメータ可変も next_pow2 で自動追従（Fs/スワス/Tp を変えれば Nr が自動で次の pow2 に）。
- 検証根拠: 「全段一貫4096 vs 4036 の圧縮画像 SNR 26dB, peak比1.00」= ターゲット保存（過去スタンドアロンで確認済み）。

### 次セッションの実装手順（推奨）
1. **n2: Nr を next_pow2 に**（上記）。これが本丸。
2. float(n42)/fixed(n43) は**巡回 Nr のまま**（revert済み、変更不要）。Nr が pow2 になるだけ。
3. **HDL(n62)**: `route_b_pipeline` は内部 `next_pow2(Nr)=Nr` で動くので、**N_FFT=_NHDL の受け渡しを撤去**して素の `route_b_pipeline(fir, chirp, Q_*)` に戻す（Nr が既に pow2 だから）。
4. **撤去**: n32 の N_req/N_HDL 計算+表示、n60 の N_HDL 定数、n62 の N_HDL メッセージ、n30 の N_req/N_HDL 行。`verilator_route_b.py` の `route_b_pipeline(N_FFT=...)` 引数も不要なら戻す（残してもよいが使わない）。
5. **検証**: route_mode=float/fixed/hdl をそれぞれ実行し、(a) 全体画像が出る、(b) 中央の継ぎ目が消える、(c) float≈fixed≈hdl を確認。画像ターゲットは重い→**フレッシュ再起動 + n18(3D)オフ**で1ルートずつ。

## 重要な運用上の注意（gotchas）
- **レンダラー OOM 白画面が頻発**: 画像ターゲット(714万点NUFFT) × 3Dプロット(n18) の組合せで V8ヒープ4GB到達。**検証時は n18 を必ず無効化**。数回ごとに `ctl.py stop/start` で再起動。現在 **n18 は無効のまま**残している。
- **canvas API の stdin**: 末尾に出る `Fatal Python error: _enter_buffered_busy` は無害（全 [OK] なら成功）。日本語 spec/code は **code_file / @file** 経由（PowerShell stdin は cp932 で日本語破損）。
- **Verilator**: MSYS2 bash 経由必須（`verilator_route_b.py` が処理）。初回ビルド ~20s、以降キャッシュ。
- **FPGA3 単独実行不可**: Fs/B/V/PRF/La 等のパラメータ定義ノードが無く、姉妹フロー(NUFFT3 等)を先に実行して kernel に値を残す前提。次セッションで n2 を編集するなら、これらが kernel にある状態で実行確認すること（or パラメータ源を確認）。
- **ワークフロー**: 実装はエージェントに委託、私(メイン)が指示+レビュー、というダブルチェック体制をユーザーが希望（このセッション後半から採用）。

## 現在の状態まとめ
- **float/fixed**: 巡回 Nr=4036 で動く（全体画像）。✅
- **HDL**: pow2(4096) で継ぎ目あり（未解決）。❌ → Nr pow2 化で解決予定。
- **n18(3D)**: 無効（メモリ対策）。route_mode=fixed, target=image（ユーザー設定）。
- 線形/N_req/N_HDL のコードが n30/n32/n60/n62 に残存（次セッションで撤去予定、害はない）。

## 参考ファイル
- 動く参照: `workspace-SAR-SIM/TargetSim_old/TargetSim_GPU_strix_good.rcflow`（n9 IQ Gen, n12 Range Compression が巡回 Nr の手本）
- 共有HDL: `workspace-SAR-SIM/scripts/verilator_route_b.py`（route_b_pipeline, quantize_bfp pow2シフト, N_FFT引数）
- スタンドアロン検証: `tmp/verify_pow2.py`（fixed vs hdl, gitignored）
- 既存引き継ぎ: `references/handoff-fpga-hil-2026-05-29.md`（Amaranth/Verilator パイプライン）
