# -*- coding: utf-8 -*-
"""HIL 出力 全要素照合ツール (element-wise comparison).

coeffs.npz の golden (Route A float ideal) と、cupy 経路 / Verilator 経路の
出力を全要素で比較する。np.testing.assert_allclose の不一致レポートに加え、
RMS / SNR / 相関 / |誤差| パーセンタイルを出す。

Verilator は FFT を pow2 (4096) にパディングするため、cupy も native(4036) と
pad(4096) の両方で計算し、「FFT長を揃えた公平比較」(cupy_4096 vs Verilator) を
行う。これで「ゲートレベル差 (truncate vs round)」だけを切り出せる。

使い方:
  .venv\\Scripts\\python.exe workspace-SAR-SIM\\scripts\\compare_hil.py
    [--npz fpga_io/coeffs.npz] [--veri fpga_io/fpga_out_verilator.npy]
"""
import argparse
import sys, io
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass
import numpy as np

try:
    import cupy as cp
    HAVE_CUPY = True
except Exception as e:
    HAVE_CUPY = False
    print("cupy 不可 (%s) — cupy 経路はスキップ" % e)


# ---- n4/n43 と同一の量子化 qz (cupy or numpy fallback) ----------------------
def _qaxis(xp, v, n_word, n_frac, scale):
    step = 2.0 ** (-n_frac)
    iv_max = (1 << (n_word - 1)) - 1
    iv_min = -(1 << (n_word - 1))
    return xp.clip(xp.round(v * scale / step), iv_min, iv_max) * step / scale


def qz(xp, x, n_word, n_frac, mode='auto'):
    if x.size == 0:
        return x.astype(xp.complex64)
    if mode == 'fixed':
        step = 2.0 ** (-n_frac)
        iv_max = (1 << (n_word - 1)) - 1
        iv_min = -(1 << (n_word - 1))
        r_q = xp.clip(xp.round(x.real / step), iv_min, iv_max) * step
        i_q = xp.clip(xp.round(x.imag / step), iv_min, iv_max) * step
        return (r_q + 1j * i_q).astype(xp.complex64)
    peak = float(xp.maximum(xp.abs(x.real).max(), xp.abs(x.imag).max()))
    if peak == 0:
        return x.astype(xp.complex64)
    full_scale = float(2 ** (n_word - 1 - n_frac))
    s = 0.95 * full_scale / peak
    r_q = _qaxis(xp, x.real, n_word, n_frac, s)
    i_q = _qaxis(xp, x.imag, n_word, n_frac, s)
    return (r_q + 1j * i_q).astype(xp.complex64)


def cupy_route_b(fir, chirp, Q_IN, Q_FFT, Q_OUT, n_fft=None):
    """n4 と同じ Route B を cupy で。n_fft 指定で pow2 パディング (Verilator 相当)。"""
    xp = cp if HAVE_CUPY else np
    Nr = fir.shape[1]
    nfft = Nr if n_fft is None else n_fft
    fir_g = xp.asarray(fir)
    chirp_g = xp.asarray(chirp.astype(np.complex64))
    # Stage A (fixed Q = ADC)
    fir_peak = float(xp.maximum(xp.abs(fir_g.real).max(), xp.abs(fir_g.imag).max()))
    pre = 0.95 / fir_peak if fir_peak > 0 else 1.0
    fir_q = qz(xp, fir_g * pre, *Q_IN, mode='fixed') / pre
    chirp_q = qz(xp, chirp_g, *Q_IN, mode='fixed')
    # Stage B (FFT x mult, BFP auto) — nfft でパディング
    F = qz(xp, xp.fft.fft(fir_q, n=nfft, axis=1), *Q_FFT)
    C = qz(xp, xp.fft.fft(chirp_q, n=nfft), *Q_FFT)
    prod = qz(xp, F * C[None, :], *Q_FFT)
    # Stage C (IFFT, BFP auto)
    s = qz(xp, xp.fft.ifft(prod, axis=1), *Q_OUT)
    s = s[:, :Nr]  # Verilator と同じく native Nr に truncate
    return cp.asnumpy(s).astype(np.complex64) if HAVE_CUPY else s.astype(np.complex64)


# ---- 全要素照合メトリクス ---------------------------------------------------
def compare(name, a, b):
    """複素配列 a (参照) と b を全要素で比較してレポート出力。"""
    a = a.ravel()
    b = b.ravel()
    assert a.shape == b.shape, "shape mismatch %s vs %s" % (a.shape, b.shape)
    diff = b - a
    abserr = np.abs(diff)
    sig_rms = float(np.sqrt(np.mean(np.abs(a) ** 2)))
    err_rms = float(np.sqrt(np.mean(abserr ** 2)))
    snr = 20 * np.log10(sig_rms / (err_rms + 1e-30))
    peak_a = float(np.abs(a).max())
    peak_b = float(np.abs(b).max())
    max_abs = float(abserr.max())
    # relative diff (要素ごと、|a| が小さいところは分母クリップ)
    denom = np.maximum(np.abs(a), 1e-6 * peak_a)
    relerr = abserr / denom
    max_rel = float(relerr.max())
    # 相関 (複素)
    corr = np.abs(np.vdot(a, b)) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-30)
    # tolerance 内割合
    within = {}
    for tol in (1e-4, 1e-3, 1e-2, 1e-1):
        within[tol] = 100.0 * np.mean(relerr <= tol)
    # |誤差| パーセンタイル (信号 peak に対する %)
    pcts = np.percentile(abserr, [50, 90, 99, 100]) / max(peak_a, 1e-30) * 100

    print("=" * 72)
    print("[%s]  N=%d 要素" % (name, a.size))
    print("  peak: ref=%.4g  test=%.4g  (test/ref=%.4f)" % (peak_a, peak_b, peak_b / max(peak_a, 1e-30)))
    print("  signal RMS=%.4g  error RMS=%.4g   ->  SNR=%.2f dB" % (sig_rms, err_rms, snr))
    print("  max |abs err|=%.4g  (= peak の %.3f%%)" % (max_abs, max_abs / max(peak_a, 1e-30) * 100))
    print("  max rel err=%.4g   複素相関=%.6f" % (max_rel, corr))
    print("  |err| percentile (vs peak):  p50=%.4f%%  p90=%.4f%%  p99=%.4f%%  max=%.4f%%"
          % (pcts[0], pcts[1], pcts[2], pcts[3]))
    print("  rel<=1e-4: %.2f%%   <=1e-3: %.2f%%   <=1e-2: %.2f%%   <=1e-1: %.2f%%"
          % (within[1e-4], within[1e-3], within[1e-2], within[1e-1]))
    # np.testing.assert_allclose の不一致レポート (落ちても続行)
    try:
        np.testing.assert_allclose(b, a, rtol=1e-2, atol=1e-2 * peak_a)
        print("  np.testing.assert_allclose(rtol=1e-2, atol=1%peak): PASS")
    except AssertionError as e:
        line = [l for l in str(e).splitlines() if 'Mismatched' in l or 'Max ' in l]
        print("  np.testing.assert_allclose(rtol=1e-2, atol=1%peak): FAIL")
        for l in line:
            print("     " + l.strip())
    return snr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--npz', default='workspace-SAR-SIM/fpga_io/coeffs.npz')
    ap.add_argument('--veri', default='workspace-SAR-SIM/fpga_io/fpga_out_verilator.npy')
    args = ap.parse_args()

    z = np.load(args.npz, allow_pickle=False)
    golden = z['golden_iq_data'].astype(np.complex64) if 'golden_iq_data' in z.files else None
    fir = z['fir_coefficients'].astype(np.complex64)
    chirp = z['chirp_replica'].astype(np.complex64).reshape(-1)
    Q_IN = (int(z['meta_Q_IN_W']), int(z['meta_Q_IN_F']))
    Q_FFT = (int(z['meta_Q_FFT_W']), int(z['meta_Q_FFT_F']))
    Q_OUT = (int(z['meta_Q_OUT_W']), int(z['meta_Q_OUT_F']))
    Nr = fir.shape[1]
    nfft_p2 = 1 << (Nr - 1).bit_length()
    print("coeffs: fir=%s  Nr=%d  pow2=%d  Q_IN=Q%d.%d Q_FFT=Q%d.%d Q_OUT=Q%d.%d"
          % (fir.shape, Nr, nfft_p2, Q_IN[0]-Q_IN[1], Q_IN[1], Q_FFT[0]-Q_FFT[1], Q_FFT[1], Q_OUT[0]-Q_OUT[1], Q_OUT[1]))

    veri = np.load(args.veri).astype(np.complex64)
    print("verilator out: %s  peak=%.4g" % (veri.shape, float(np.abs(veri).max())))

    cupy_native = cupy_route_b(fir, chirp, Q_IN, Q_FFT, Q_OUT, n_fft=Nr)
    cupy_p2 = cupy_route_b(fir, chirp, Q_IN, Q_FFT, Q_OUT, n_fft=nfft_p2)
    print("cupy native(%d): peak=%.4g   cupy pad(%d): peak=%.4g"
          % (Nr, float(np.abs(cupy_native).max()), nfft_p2, float(np.abs(cupy_p2).max())))

    if golden is not None:
        compare("golden(4036) vs cupy_native(4036)", golden, cupy_native)
        compare("golden(4036) vs Verilator(pad4096)", golden, veri)
    # 本命: FFT長を揃えた cupy vs Verilator = ゲートレベル差のみ
    compare("cupy_pad(4096) vs Verilator(pad4096)  << FFT長一致・ゲート差", cupy_p2, veri)
    # 参考: FFT長違いの cupy vs Verilator
    compare("cupy_native(4036) vs Verilator(pad4096) << FFT長不一致", cupy_native, veri)


if __name__ == '__main__':
    main()
