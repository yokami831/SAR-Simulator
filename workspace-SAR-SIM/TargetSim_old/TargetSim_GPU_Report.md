# TargetSim_GPU 変更レポート

## 概要

元のJupyter Notebook `tagert_sim_org.ipynb` をHiyoCanvasのフローに移植し、GPU高速化・プロット改善・IQ生成方式変更を行った記録。

**ファイル:**
- `TargetSim_GPU.rcflow` — 現在のフロー（FFT方式IQ生成 + GPU高速化）
- `TargetSim_GPU_TimeDomain.rcflow` — バックアップ（時間領域IQ生成版）
- 元のNotebook: `D:\yoshitaka\TargetSimulator2\ImageTest\tagert_sim_org.ipynb`

---

## パラメータ変更

| パラメータ | オリジナル | 現在 | 変更理由 |
|-----------|----------|------|---------|
| `fs` | 100 MHz | **187.5 MHz** (3000e6/16) | 実際に使いたいサンプリング周波数に合わせた |
| `fc` | 9.65 GHz | **9.6 GHz** | 同上 |
| `prf` | 4000 Hz | 4000 Hz | 変更なし |
| `chirp_bw` | 75 MHz | 75 MHz | 変更なし |

fs変更によりデータサイズが増加（nsamples: 10966 → 20564）。分解能への影響は理論上なし（帯域幅が同じため）。

---

## ブロック別 変更内容

### n1: Imports & Utils
**変更点:**
- `image_plot_dB` 関数に `extent`, `xlabel`, `ylabel` 引数を追加（物理単位の軸表示）
- **max-pooling**を追加: 大配列を表示用に縮小（600×800目標）。`db_data.reshape(...).max(axis=(1,3))`
- `aspect='auto'` を追加（RDドメイン等でアスペクト比が極端な場合の対応）
- `plt.tight_layout()` を追加

**max-poolingの理由:** matplotlibの`imshow`が5400×20564の配列をレンダリングするのに4-5秒かかっていた。max-poolingで点ターゲットを消さずに配列サイズを縮小し、0.7秒に短縮。間引き（ダウンサンプル）はSARの点ターゲット（数ピクセル）が消失するため不可。max-poolingなら最大値を保持するので点が消えない。

### n3: Radar Params（旧n2: Constants + n3を統合）
**変更点:**
- `fs = 3000e6/16`（187.5MHz）に変更
- `fc = 9.6e9` に変更
- 定数 `c` をこのブロックに統合

### n4: Platform Params
**変更点:**
- Antenna Patternブロック（旧n5）を統合

### n9: IQ Data Generation ★最大の変更
**オリジナル（時間領域）:**
```python
for i in range(len(slow_time)):
    for j in range(len(points)):
        r = 距離計算
        rect = 矩形窓
        iq_data[i,:] += rect * exp(j*chirp_phase) * exp(-4πjr/λ) * antenna
```

**現在（FFT方式 V2）:**
```python
chirp_fft = FFT(chirp_padded)  # 1回だけ計算
for i in range(len(slow_time)):
    echo_fft = zeros(nfast)
    for j in range(len(points)):
        echo_delay = 2*r/c - fast_time[0]
        echo_fft += chirp_fft * exp(-j2πf·echo_delay) * exp(-4πjr/λ) * s_az
    iq_data[i,:] = IFFT(echo_fft)
```

**変更理由:**
- 時間遅延τのチャープは周波数領域では `Chirp(f) × exp(-j2πfτ)` と表現できる（位相回転）
- FIR係数を作ってFFTする方法（V1）と数学的に等価だが、V2はFIR配列生成とFFTのステップを省略でき効率的
- 将来の画像ターゲット拡張（複数点のGPU並列化）の基盤
- FPGAでのリアルタイム反射模擬と同じ原理（受信信号FFT → 周波数領域で乗算 → IFFT）

**V1との関係:** `FFT(delta(n - n0)) = exp(-j2πf·n0/N)` なので、FIR係数のFFTを解析的に直接計算しているのがV2。計算ステップが少ないため誤差も少ない。

### n10, n13: IQ Data Plot, RC Plot
**変更点:**
- `extent` に物理単位を設定: `slant_range = c * fast_time / 2 / 1e3`（km）
- `xlabel='Range (km)'`, `ylabel='Azimuth (km)'`

**`rg_array`を使わない理由:** 元のNotebookの `rg_array = c * fast_time + r_sc` は物理的に意味のない値（往復伝搬距離+r_sc ≈ 2,080,000m）。正しいスラントレンジは `c * fast_time / 2`（≈695,000m、ターゲット設置位置と一致）。`rg_array`は元のNotebookのどの処理にも使われておらず、定義だけの変数だった。

**kmにした理由:** メートル単位だと690000〜706000の値がプロットの軸ラベルに収まらず重なるため。

### n12: Range Compression ★GPU化
**オリジナル:**
```python
iq_data_f = np.fft.fft(iq_data, axis=1)
for i in range(iq_data.shape[0]):
    iq_rg_cmp[i,:] = np.fft.ifft(iq_data_f[i,:] * np.conj(t_chirp_d_f))
```

**現在（GPU）:**
```python
import cupy as cp
iq_data_gpu = cp.asarray(iq_data)
iq_data_f = cp.fft.fft(iq_data_gpu, axis=1)
iq_rg_cmp_gpu = cp.fft.ifft(iq_data_f * ref_f[cp.newaxis, :], axis=1)
iq_rg_cmp = cp.asnumpy(iq_rg_cmp_gpu)
```

**変更理由:** 行ごとのループを排除し、2D FFTとブロードキャスト乗算でGPU一括処理。GPUメモリ解放（`del` + `free_all_blocks()`）を各ステップ後に実施。

### n14: Azimuth FFT ★GPU化
**変更点:** `np.fft.fftshift(np.fft.fft(...))` → `cp.fft.fftshift(cp.fft.fft(...))`
GPUメモリ解放付き。

### n15, n17, n20: RD Plot, RCMC Plot, Az Comp Plot
**変更点:**
- X軸: `slant_range = c * fast_time / 2 / 1e3`（km）
- Y軸: `doppler_axis`（Hz）
- `xlabel='Range (km)'`, `ylabel='Doppler (Hz)'`

### n16: RCMC ★GPU化（最大の高速化）
**オリジナル:**
```python
for i in range(iq_data_rd.shape[1]):
    rcm[:,i] = (1/sqrt(1-(wl*freq/(2*veff))^2)-1) * (r_sc + d_rg*i)
for i in range(iq_data_rd.shape[0]):
    f = interp1d(R, iq_data_rd[i], kind="cubic", fill_value="extrapolate")
    iq_data_rcmc[i] = f(R_new[i])
```

**現在（GPU float32 staged）:**
```python
# GPU上で座標計算
col_coords = col_base + migration_factor * (r_sc_px + col_base)
# 実部・虚部を別々にGPU転送 → cubic補間 → 転送戻し（メモリ節約）
out_real = gpu_map_coordinates(iq_real_gpu, coords_gpu, order=3, mode='nearest')
# 各ステップ後にGPUメモリ解放
```

**変更理由:**
- `scipy.interpolate.interp1d`を5400回生成する処理が最大ボトルネックだった
- CuPyの`map_coordinates`で2D一括cubic補間
- **float32 vs float64:** float32は約1.3%のレンジ分解能差があるが、ピーク位置は完全一致。float64は完全一致するがVRAM 8GBでは2倍遅い。コード内にコメントで記載済み
- **mode='nearest':** 端の外挿処理。`fill_value='extrapolate'`に近い挙動
- **staged処理:** 実部・虚部を別々にGPU転送し、各ステップ後にメモリ解放。これによりGPUメモリ不足によるスラッシングを防止

### n19: Az Compression ★GPU化
**オリジナル:**
```python
def azimuth_compression(data):
    for i in range(len(data[0])):
        az_ref = azimuth_reference(ri, datalen)
        az_ref = conj(fftshift(fft(az_ref)))
        data[:,i] = data[:,i] * az_ref
```

**現在:**
```python
# CPUで全列分のchirpを生成（ループだが各chirpは小さいので高速）
for i in range(ncols):
    padded_all[i,:npts] = exp(1j * phase)
    padded_all[i] = roll(padded_all[i], -shift)
# GPU batch FFT（全列を一括FFT）
az_refs_gpu = conj(fftshift(fft(padded_gpu, axis=1)))
# GPU乗算
iq_az_cmp = iq_data_rcmc * az_refs_gpu.T
```

**変更理由:** CPU上のFFTループ（20564回）をGPUバッチFFTに置換。チャープ生成はCPUのまま（各chirpが小さくGPU転送のほうが遅い）。

### n21: Az IFFT ★GPU化
**変更点:** `np.fft.ifft(np.fft.fftshift(...))` → CuPy版 + メモリ解放

### n22: Peak & Zoom Plot
**変更点:**
- `peak_idx`のprint文にメートル単位の物理座標を追加
- `extent`をkmで表示（ピーク中心の実座標がわかるように）
- `slant_range = c * fast_time / 2`（正しいスラントレンジ）を使用

### n23, n24: Range/Azimuth Profile
**変更点:**
- X軸をkm単位に変更

---

## GPUメモリ管理の教訓

RTX 3060 Ti (8GB VRAM) で5399×20564の配列を処理する際、GPUメモリ管理が性能に大きく影響した。

**問題:** 各GPUブロックでメモリを解放しないと、後続ブロックでメモリ不足 → スラッシング → 数倍遅くなる

**解決:** 各GPUブロックの末尾で:
```python
del gpu_array
cp.get_default_memory_pool().free_all_blocks()
```

これにより RCMC が 9s → 2s に安定化した。

---

## FFT点数とデータサイズ

| パラメータ | 値 | 備考 |
|-----------|-----|------|
| nsamples (FFT点数) | **20,563** | 2の冪乗ではない |
| 内訳: チャープ長 | 11,718 samples (62.5μs) | duty=25% × PRI × fs |
| 内訳: スワス分 | 8,845 samples (47.2μs) | sqrt(range_swath² + az_swath²) の往復 |
| npulses (パルス数) | 5,399 | azimuth_swath / veff × prf |
| 配列サイズ | 5,399 × 20,563 | ≈1.1億要素 (complex64) |

### FPGA実装に向けた注意
- FPGAのFFTは通常**2の冪乗**が必要 → **2^15 = 32,768点**にゼロパディング
- 32,768 - 20,563 = 12,205サンプルの余裕がある
- この余裕分でスワスを拡大することも可能（ただしリファレンスとの比較が必要）

### duty比について
- 現在duty=25%は実運用のSARシステム（通常5-10%）と比べて高い
- チャープ長（11,718）がスワス分（8,845）より長い
- シミュレーション検証用としては問題ないが、実システムのパラメータに変更する場合はチャープ長が短くなりスワス分の比率が増える

---

## 処理時間比較（fs=187.5MHz）

| ブロック | オリジナルCPU | GPU版（現在） | 高速化率 |
|---------|-------------|-------------|---------|
| IQ Data Generation | 2.7s | 7.3s (FFT方式) | ※方式変更のため単純比較不可 |
| IQ Data Plot | 4.5s | 1.2s | 3.8x |
| Range Compression | 5.4s → ※ | 1.0s | 5.4x |
| Azimuth FFT | 3.2s → ※ | 1.6s | 2.0x |
| RCMC | 11.5s → ※ | 2-7s (変動あり) | 2-6x |
| Az Compression | 4.7s → ※ | 3.5s | 1.3x |
| Az IFFT | 2.6s → ※ | 2.1s | 1.2x |

※ fs=187.5MHzでのオリジナルCPU時間は未計測（fs=100MHzの値を参考表示）

---

## 結果検証

### CPU版リファレンス（fs=187.5MHz、時間領域）との比較

| 項目 | CPU版 | GPU FFT版 |
|------|-------|-----------|
| Peak az | 2699 | **2699** ✅ |
| Peak rg | 6254 | **6254** ✅ |
| Peak amplitude | 21,001,890 | 同等 |
| Range Resolution | 1.892 m | **1.868 m**（1.3%差、RCMC float32由来） |
| Azimuth Resolution | 2.278 m | **2.277 m** ✅ |

- ピーク位置は完全一致
- 分解能のレンジ方向1.3%差はRCMCのfloat32補間が原因（float64なら完全一致するが2倍遅い）
- アジマス分解能は一致

---

## 座標系の整理

- **アジマス軸:** `az_array = veff * slow_time` → 中心が0m（観測エリア中心）
- **レンジ軸:** `slant_range = c * fast_time / 2` → スラントレンジ距離（m）
  - ターゲット設置: `r_sc + range_swath/2 = 695,000m`
  - 検出位置: `slant_range[6254] = 694,999.7m` → 一致
- **`rg_array = c * fast_time + r_sc`** は物理的に意味がない値（往復距離+r_sc）。処理には使われておらず、プロットにも使わない。
- プロット表示はkm単位（mだとラベルが重なるため）

---

## IQ生成のGPU化（追加実施）

V2 FFT方式のIQ生成をさらにGPU化：
- 全パルスの距離・位相計算をnumpy vectorizeでまとめてGPU転送
- `(npulses, nfast)` の2D配列として一括計算
- バッチIFFTで全パルスを一度に変換

結果: **7.25s → 1.83s（4倍高速）**、浮動小数点版と完全一致。

ポイント数が増えても各ポイントの寄与は`echo_fft_all +=`の加算だけなので、FFT/IFFTの回数は変わらない。

---

## 固定小数点精度検討

### 目的
FPGAでの反射波模擬を見据え、IQ生成の周波数領域処理を固定小数点化した場合の精度影響を検討。

### 使用ライブラリ
- **fxpmath** — 固定小数点演算ライブラリ（`Fxp`クラスで量子化シミュレーション）

### 処理フロー（FPGA想定）
```
チャープ信号（ADC入力）→ FFT → × 反射係数 → IFFT → 反射波出力
```
各ステージでFxpによる量子化を挿入し、ビット幅ごとの影響を測定。

### 各ステージのダイナミックレンジ
| ステージ | 最大振幅 | 16bit時のQ形式 |
|---------|---------|--------------|
| チャープ信号（ADC） | 1.00 | Q2.14 |
| FFT出力 | 200.86 | Q9.7 |
| 位相係数 | 1.00 | Q1.15 |
| 乗算結果 | 200.86 | Q9.7 |
| IQ出力（1点） | 1.07 | Q2.14 |
| IQ出力（100点） | 4.59 | Q4.12 |

**注意:** FFT出力のダイナミックレンジが大きい（max≈200）。全ステージ同一Q形式ではクリップが発生するため、各ステージで異なるn_fracの設定が必要。

### 1点ターゲットでの結果

| ビット幅 | ピーク位置 | 振幅誤差 | SNR | 判定 |
|---------|-----------|---------|------|------|
| 8 bit | NG | 60.3% | 0.0 dB | ❌ |
| 10 bit | NG | 56.9% | 0.1 dB | ❌ |
| 12 bit | **OK** | 2.93% | 50.7 dB | ⚠️ |
| 14 bit | OK | 0.73% | 62.7 dB | ✅ |
| 16 bit | OK | 0.19% | 74.6 dB | ✅ |
| 20 bit | OK | 0.01% | 98.5 dB | ✅ |
| 24 bit | OK | 0.001% | 122.6 dB | ✅ |
| 32 bit | OK | 0.000% | 170.7 dB | ✅ |

### 100点ターゲットでの結果（画像ターゲット模擬）
100点をランダム配置、振幅0.01〜1.0（対数一様分布）。強い点17個、弱い点42個。

| ビット幅 | ピーク位置 | 振幅誤差 | SNR | 判定 |
|---------|-----------|---------|------|------|
| 8 bit | NG | 100.0% | 0.0 dB | ❌ |
| 10 bit | NG | 50.1% | 3.0 dB | ❌ |
| 12 bit | **NG** | 21.7% | 10.6 dB | ❌ |
| 14 bit | OK | 5.24% | 20.4 dB | ⚠️ |
| 16 bit | OK | 0.56% | 30.9 dB | ⚠️ |
| 20 bit | OK | 0.02% | 53.8 dB | ✅ |
| 24 bit | OK | 0.002% | 77.4 dB | ✅ |
| 32 bit | OK | 0.000% | 125.2 dB | ✅ |

### 考察
- ターゲット数が増えるとSNRが約40dB悪化（100点の場合）
- 1点ターゲットでは12bitでピーク位置OK → 100点では12bitでNG
- **14bit**: 100点でピーク位置は合うがSNR 20.4dBでやや不安
- **16bit**: 30.9dB、最低限の実用レベル
- **20bit以上**: 53.8dB以上で安定
- 画像ターゲット（数千〜数万点）ではさらに厳しくなる可能性あり

### 今後の検討事項
- 現在は全ステージ同一ビット幅で検討。FPGAでは各ステージのビット幅を独立に設定可能：
  - ADC入力: ハードウェアで決まる（例: 14bit）
  - FFT twiddle factor: 別のビット幅（例: 16bit, 18bit）
  - 反射係数テーブル: さらに別のビット幅
- ステージごとの感度分析で、どの部分にビットを割くべきか最適化する必要あり

---

## 画像ターゲットIQ生成の速度最適化

### 背景
V2 FFT方式のIQ生成を画像ターゲット（多数のポイント）に拡張する際の処理速度が課題。ya.png（260×260、非ゼロ63,056ピクセル）を目標。

### ボトルネック分析
IQ生成の内側処理（各パルス × 各ターゲット）で：
1. `cp.exp(-j2πf·delay)`: 位相回転の計算（`(nb_t, nfast)`のexp）— **最も重い**
2. `cp.sqrt`, `cp.arctan`, `cp.sinc`: 距離・角度計算
3. `cp.exp(-4πjr/λ)`: レンジ位相
4. GPUカーネル呼び出しオーバーヘッド（Pythonのforループ5399回）

### 試行した最適化と結果（26x26 = 675ターゲットで計測）

| 方式 | 時間 | /tgt | ya推定 | 効果 |
|------|------|------|--------|------|
| ① exp毎回 complex128 バッチ(tb=80,pb=40) | 54.9s | 0.081s | 85分 | ベースライン |
| ② complex64化 + バッチ(tb=80,pb=40) | 54.5s | 0.081s | 85分 | メモリ半減のみ、速度変わらず |
| ③ 差分位相（パルスloop、reset=100） | 25.8s | 0.038s | 40分 | **2.1倍高速** ✅ |
| ④ 差分位相 + range phaseも差分 | 25.2s | 0.037s | 39分 | 微改善のみ |
| ⑤ バッチ(tb=80,pb=40) + 差分位相（内側loop） | 22.6s | 0.034s | 35分 | 若干改善 |
| ⑥ バッチ + cumprod（内側loop排除） | 悪化 | - | - | 3D配列生成が重すぎ |

### 各方式の詳細

#### ③ 差分位相方式（現在採用）
```python
# 初回 or reset時: 全計算
cur_phase = exp(-j2πf·delay)  # (nb_t, nfast) のexp

# 以降: 差分の乗算で更新（expの代わりに複素乗算）
d_delay = delay_new - delay_prev
delta_phase = exp(-j2πf·d_delay)  # これもexpだが…
cur_phase = prev_phase * delta_phase  # 乗算は高速
```
- **効果**: exp→乗算の置換でexpの計算コストが約半分に
- **精度**: reset_interval=100で100パルスごとにexpを再計算、誤差蓄積を防止
- reset_interval=500にしても速度変わらず → expの頻度はもはやボトルネックではない

#### ② complex64化
- メモリは半減するが、expの演算量は同じなので速度は変わらない
- バッチサイズ拡大の余地は増えるが、バッチサイズを増やしても速度に効かない

#### ⑤ バッチ+差分の組み合わせ
- 距離計算(`sqrt`, `arctan`, `sinc`)をバッチで一括 → Pythonループ回数削減
- 位相計算は差分で更新
- ③より10%程度改善だが、コードが複雑になる

#### ⑥ cumprod方式（失敗）
- 3D配列 `(nb_t, pb, nfast)` = 526MBの生成・cumprodが重い
- GPUメモリ確保/解放のオーバーヘッドが大きい
- ベースラインより悪化

### NUFFT導入（⑦） ★大幅改善

#### 原理
IQ生成の核心計算 `S[f_k] = Σ_j w_j · exp(-j2π·f_k·τ_j)` は、不均等点から均等グリッドへのフーリエ変換（NUFFT Type 1）そのもの。

- **従来**: O(N×M) = 20,564周波数 × ターゲット数 ≈ 13億演算/パルス
- **NUFFT**: O(N·logN + M) ≈ 37万演算/パルス（理論上3,500倍）

#### ライブラリ
- **finufft**（CPU版）: `pip install finufft`。Windows対応、高速（FFTW+SIMD最適化）
- **cufinufft**（GPU版）: WindowsではCUDA DLL依存問題で動作せず
- **torchkbnufft**（PyTorch GPU版）: 動作するがCPU finufftより遅い（GPUカーネル起動オーバーヘッド）
- **pynufft**（CuPyバックエンド）: CuPyバージョン互換性問題あり

**結論: CPU finufftが最速**。GPUオーバーヘッドよりCPUのSIMD最適化が上回る。

#### NUFFT座標変換の注意
- finufftのType 1出力はfftshift済み → `np.fft.ifftshift()`が必要
- 座標変換: `x = -2π·fs·τ/N`

#### 精度検証
1点・100点で直接計算と比較: **SNR 148.7dB**（実質完全一致）

#### 結果: ターゲット数に依存しない処理時間

| 画像サイズ | ターゲット数 | 時間 | /tgt |
|-----------|------------|------|------|
| 26×26 | 675 | 25s | 0.037s |
| 65×65 | 4,079 | 26s | 0.006s |
| 260×260 (ya.png) | 63,056 | ~5min | - |

ターゲット数が6倍になっても時間がほぼ同じ = NUFFTが O(N·logN) で動いている証拠。

### GPU前処理 + CPU NUFFT ハイブリッド（⑧） ★現在採用

#### 方式
- **GPU（CuPy）**: 距離計算、角度計算、アンテナパターン、位相計算を全パルス一括バッチ処理
- **CPU（finufft）**: NUFFT本体。GPUで計算した座標と重みをCPUに転送

#### float32精度の落とし穴
**位相計算 `exp(-4πjr/λ)` はfloat64が必須。**

r ≈ 690,000m、λ ≈ 0.031m → r/λ ≈ 22,000,000。float32の有効桁数7桁では、距離の1m未満の誤差で位相が数ラジアンずれて画像が完全に崩壊する。

- 距離計算 (`sqrt`): float64
- 位相 (`exp(-4πjr/λ)`): float64 → complex64にキャスト
- NUFFT座標: float32でOK（座標精度はそこまでクリティカルでない）
- アンテナパターン: float32でOK

#### パルスバッチ処理
GPUメモリ制限（8GB）のため、全パルスを一括計算できない場合がある。
`pb = min(500, int(2GB / (nt * 32 bytes)))` で自動調整。

#### 結果

| 画像 | ターゲット数 | 時間 |
|------|------------|------|
| small.png (45×45) | 1,927 | ~30s |
| ya.png (260×260) | 63,056 | ~5min |
| strix.png (1024×1024) | 678,233 | **84.3s** |

strix.pngで678,233ターゲットが84秒。ターゲット数が10倍でも処理時間は線形より大幅に小さい。

### 処理時間の内訳分析（strix.png 678,233ターゲット）

| 処理 | 推定時間 | 備考 |
|------|---------|------|
| NUFFT本体 (finufft) | ~17s | 3ms/パルス × 5399 |
| GPU距離/位相計算 | ~40s | float64のため重い |
| GPU→CPU転送 | ~10s | |
| IFFT + chirp乗算 | ~10s | |
| Pythonループオーバーヘッド | ~7s | 5399回の関数呼び出し |

### 画像ターゲットの設定

```python
target_mode = "image"  # or "point" で切り替え可能

# 画像の反転: dark = strong reflection
gray = 255.0 - gray

# ピクセル間隔（SAR分解能に合わせる）
pixel_spacing_rg = 2.0  # m/pixel
pixel_spacing_az = 6.0  # m/pixel（アジマス3倍引き伸ばし）

# スワス中央に配置
rg_center = r_sc + range_swath / 2
```

### パイプライン並列化（⑨） ★現在採用

#### 問題
全パルスの座標・重みを一度にメモリに載せると44.8GB必要（678Kターゲット×5399パルス）。
スワップが発生してNUFFTが極端に遅くなる。

#### 解決: パイプライン + finufft内部スレッド制御

**発見**: finufftはデフォルトで全CPUコアを使おうとするが、1パルス分の小さな問題サイズでは
スレッド生成のオーバーヘッドが計算を上回る。`nthreads=1`にするだけで**2.7倍高速化**。

```python
# finufft内部スレッド=1、外側で8スレッド並列
plan = finufft.Plan(1, (nfast,), eps=1e-6, dtype='complex64', nthreads=1)

# ThreadPoolExecutorで並列化（finufftはGILを解放する）
with ThreadPoolExecutor(max_workers=8) as executor:
    ...
```

#### ベンチマーク結果（NUFFT部分のみ、50,000ターゲット）
| 方式 | 時間 | 高速化 |
|------|------|--------|
| Sequential (default threads) | 16.2s | baseline |
| Sequential (nthreads=1) | 6.1s | 2.7x |
| 4 threads (nthreads=1) | 1.9s | 8.4x |
| **8 threads (nthreads=1)** | **1.4s** | **11.8x** |
| 12 threads (nthreads=1) | 1.3s | 12.2x |

#### パイプライン構造
```
バッチ(92パルス)ごとに:
  1. GPU precompute (距離・位相) → CPU転送  [~750MB/バッチ]
  2. 8スレッド並列 NUFFT (nthreads=1)
  3. メモリ解放 → 次のバッチ
最後: 全S_allをGPUでバッチIFFT
```

メモリ使用量: 44.8GB → **~750MB**（バッチ分のみ）

#### 結果
| 画像 | ターゲット数 | 前回 | **並列化後** | 改善 |
|------|------------|------|------------|------|
| strix.png (1024×1024) | 678,233 | 84.3s | **42.5s** | **2.0x** |

### 現在の結論
- **NUFFT + GPU precompute + パイプライン並列化**が最適解
- finufftは`nthreads=1`で外側並列化が最も効率的
- CPU finufftがGPU NUFFTより高速（Windows環境）
- float64は距離・位相に必須（float32では画像崩壊）
- 678,233ターゲットで42.5秒

### 画像ターゲット処理時間一覧

| 画像 | サイズ | ターゲット数 | 時間 |
|------|--------|------------|------|
| small.png | 45×45 | 1,927 | ~30s |
| ya.png | 260×260 | 63,056 | ~5min |
| strix.png | 1024×1024 | 678,233 | 42.5s |
| photo_large.png | 1834×2055 | 3,768,826 | ~6min |

### 表示の注意点
- `image_plot_dB`の`threshould_dB`パラメータで見え方が大きく変わる
- 写真画像: 0〜20dBが適切（60dBだと白飛びする）
- 線画（ya.png, strix.png）: 60dBでOK
- `mode='fast'`（max-pooling）は点ターゲット向け。写真画像は`mode='quality'`推奨
- 画像サイズがスワスを超える場合はpixel_spacingを自動調整（90%マージン）

---

## GUI化

### GUIウィジェットブロック（n8の前に配置）

| ブロック | タイプ | 変数名 | 説明 |
|---------|--------|--------|------|
| Target Mode | Dropdown | `target_mode` | "point" / "image" 切り替え |
| Image File | File Picker | `image_path` | 画像ファイル選択（png, jpg, bmp） |
| Invert B/W | Toggle | `invert_image` | 白黒反転ON/OFF |

接続: Swath & Time Axes → Target Mode → Image File → Invert B/W → Target Definition → IQ Gen

### pixel_mode（n8内の定数）

| モード | ピクセル間隔 | 用途 |
|--------|------------|------|
| `"1to1"` | d_rg × d_az (0.799m × 1.853m) | 1ピクセル=1SARサンプル。大きい画像向け |
| `"fit"` | スワス90%に自動フィット | スワス全体に画像を引き伸ばす |
| `"fixed"` | 2.0m × 6.0m | 前回きれいに出た固定値。小さい画像向け |

**注意:** `"1to1"`で小さい画像（small.png等）を使うと、画像スパンがSAR分解能と同スケールになりにじんで見える。小さい画像には`"fixed"`推奨。

### SLC Plot（n22）の表示モード
- `plot_mode = "peak"`: ポイントターゲット位置（r_sc + range_swath/2, azimuth=0）を中心にzoom表示。ピーク位置ではなく固定位置中心なので、画像ターゲットでも常に画像が中央に来る。位置ずれがあれば一目でわかる。
- `plot_mode = "full"`: SLC全体表示

### 白黒反転について
- 線画（ya.png, strix.png）: `invert_image = True`（暗い線が強い反射）
- 写真（photo_large.png）: `invert_image = False`（明るい部分が強い反射）
- 反転を間違えると白い部分が灰色がかって見える

---

## FPGA分割（最新）

### ファイル名変更
`TargetSim_GPU.rcflow` → `TargetSim_FPGA.rcflow`

### ノード分割
n9を2つに分割し、FPGA置き換え対象を明確化：

| ノード | 名前 | 処理 | 実行環境 |
|--------|------|------|---------|
| n9 | Reflection Coefficients | GPU precompute + 並列NUFFT → `S_all`, `chirp_fft` | PC (GPU+CPU) |
| **n32** | **FPGA Simulation** | `iq_data = IFFT(chirp_fft × S_all)` | **現在GPU、将来FPGA** |

### フロー接続
```
... → n8 (Target Definition) → n9 (Reflection Coefficients) → n32 (FPGA Simulation) → n10 (IQ Plot) / n11 (Range Ref) → ...
```

### FPGA化の対象（n32の処理）
```
入力チャープ信号 → FFT → × 反射係数(S_all) → IFFT → 反射波出力
```
この処理をAmaranth HDLシミュレーション → 実FPGAに段階的に置き換える。

---

## 今後の拡張方針

1. **n32のHDLシミュレーション化:** Amaranth HDLでchirp FFT × 係数 → IFFTを実装、浮動小数点版と比較検証
2. **固定小数点のステージ別最適化:** 画像ターゲットの状態でビット幅検証（ADC, FFT係数, 反射係数を独立に調整）
3. **さらなる速度最適化:** GPUとCPUのパイプライン重ね合わせ
4. **参考:** `D:\yoshitaka\TargetSimulator2\ImageTest\` にMethod30-39の試行錯誤あり。画像配置方式が現フローと異なる（ポイント一列+アジマス重み方式）
