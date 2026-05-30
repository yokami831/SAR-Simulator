"""
Verify the Xilinx xfft v9.1 bit-accurate C-model ctypes binding against numpy.

Run:  .venv\\Scripts\\python.exe workspace-SAR-SIM\\scripts\\test_xfft_cmodel.py

Gates:
  1. Forward FFT vs numpy (N=4096): SNR in the ~60-90 dB range (16-bit
     twiddles + truncation). Empirically pick BFP recovery sign.
  2. IFFT normalization convention vs numpy, determined empirically.
  3. Runtime-N works across N=256/4096/32768 with one cached state.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xfft_cmodel import xfft, quantize_q15, destroy_state  # noqa: E402


def snr_db(ref: np.ndarray, test: np.ndarray) -> float:
    err = np.linalg.norm(test - ref)
    sig = np.linalg.norm(ref)
    if err == 0:
        return float("inf")
    return 20.0 * np.log10(sig / err)


def make_signal(N: int, peak: float = 0.3, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = (rng.standard_normal(N) + 1j * rng.standard_normal(N)).astype(np.complex128)
    x *= peak / np.max(np.abs(x))
    return x


def best_recovery(y_hw: np.ndarray, be: int, y_ref: np.ndarray):
    """Try both BFP recovery signs; return (sign_str, y_true, snr)."""
    cands = {
        "y_hw * 2**(+be)": y_hw * (2.0 ** be),
        "y_hw * 2**(-be)": y_hw * (2.0 ** (-be)),
    }
    best = max(cands.items(), key=lambda kv: snr_db(y_ref, kv[1]))
    sign, y_true = best
    return sign, y_true, snr_db(y_ref, y_true)


def main() -> int:
    results = []
    print("=" * 72)
    print("Xilinx xfft v9.1 bit-accurate C-model  vs  numpy")
    print("=" * 72)

    # ----- Test 1: forward FFT vs numpy (N=4096) -----------------------
    N = 4096
    x = make_signal(N, peak=0.3, seed=1)
    x_q = quantize_q15(x)
    y_hw, be = xfft(x, direction=1)
    y_ref = np.fft.fft(x_q)

    sign, y_true, snr = best_recovery(y_hw, be, y_ref)
    print(f"\n[Test 1] Forward FFT vs numpy, N={N}")
    print(f"  blk_exp = {be}")
    print(f"  BFP recovery convention: y_true = {sign}")
    print(f"  SNR(y_true vs np.fft.fft) = {snr:.2f} dB")
    # raw (unrecovered) SNR for contrast
    print(f"  (raw y_hw vs y_ref SNR = {snr_db(y_ref, y_hw):.2f} dB)")
    fwd_pass = 40.0 <= snr <= 110.0 and sign == "y_hw * 2**(+be)"
    # Document expectation: header/datasheet => recovery is *2^(+be) since BFP
    # right-shifts (scales DOWN) the data and reports the total shift in be.
    results.append(("Forward FFT SNR in [40,110] dB", fwd_pass,
                    f"SNR={snr:.2f}dB, conv=y_hw*2^(+be)"))
    fwd_sign = sign

    # ----- Test 2: IFFT normalization convention ----------------------
    # Feed a known frequency-domain vector X into the inverse transform and
    # compare against numpy's ifft, trying the unscaled (sum) vs 1/N forms.
    N2 = 4096
    Xf = make_signal(N2, peak=0.3, seed=7)   # treat as frequency-domain input
    Xf_q = quantize_q15(Xf)
    z_hw, be2 = xfft(Xf, direction=0)
    # numpy inverse, both normalizations:
    z_ifft_div = np.fft.ifft(Xf_q)        # numpy default: divides by N
    z_ifft_sum = np.fft.ifft(Xf_q) * N2   # unscaled inverse (sum form)

    # Apply the forward BFP recovery sign we found, then test both norms.
    sgn = (2.0 ** be2) if fwd_sign == "y_hw * 2**(+be)" else (2.0 ** (-be2))
    z_true = z_hw * sgn
    snr_div = snr_db(z_ifft_div, z_true)
    snr_sum = snr_db(z_ifft_sum, z_true)
    if snr_sum >= snr_div:
        ifft_conv = "unscaled (== np.fft.ifft(x)*N, NO 1/N divide)"
        ifft_snr = snr_sum
    else:
        ifft_conv = "scaled by 1/N (== np.fft.ifft(x))"
        ifft_snr = snr_div
    print(f"\n[Test 2] IFFT normalization, N={N2}")
    print(f"  blk_exp = {be2}")
    print(f"  SNR vs np.fft.ifft*N (unscaled/sum) = {snr_sum:.2f} dB")
    print(f"  SNR vs np.fft.ifft   (1/N scaled)   = {snr_div:.2f} dB")
    print(f"  => IFFT convention: {ifft_conv}  (SNR={ifft_snr:.2f} dB)")
    results.append(("IFFT matches a numpy convention >=40 dB", ifft_snr >= 40.0,
                    f"{ifft_conv}, SNR={ifft_snr:.2f}dB"))

    # ----- Test 2b: FFT -> IFFT round-trip --------------------------------
    # x --FFT--> recover --IFFT--> recover, compare to x_q*N (unscaled inverse
    # of a forward gives N*x). We use recovered values at each stage.
    xr = make_signal(2048, peak=0.3, seed=3)
    xr_q = quantize_q15(xr)
    Y, beY = xfft(xr, 1)
    Y_true = Y * (2.0 ** beY) if fwd_sign == "y_hw * 2**(+be)" else Y * (2.0 ** (-beY))
    # IFFT expects pre-quantized input in [-1,1). Re-normalize Y_true into range.
    scale_in = 0.9 / np.max(np.abs(Y_true))
    Z, beZ = xfft((Y_true * scale_in).astype(np.complex64), 0)
    Z_true = Z * (2.0 ** beZ) if fwd_sign == "y_hw * 2**(+be)" else Z * (2.0 ** (-beZ))
    # Undo the input scaling; unscaled inverse of fft(x_q) == N * x_q.
    Z_recovered = Z_true / scale_in / 2048
    snr_rt = snr_db(xr_q, Z_recovered)
    print(f"\n[Test 2b] FFT->IFFT round-trip, N=2048")
    print(f"  SNR(round-trip vs quantized input) = {snr_rt:.2f} dB")
    results.append(("Round-trip FFT->IFFT >=30 dB", snr_rt >= 30.0,
                    f"SNR={snr_rt:.2f}dB"))

    # ----- Test 3: runtime-N across sizes with one state ------------------
    print(f"\n[Test 3] Runtime-N (C_HAS_NFFT=1), one cached state")
    size_ok = True
    for Nk in (256, 4096, 32768):
        xk = make_signal(Nk, peak=0.3, seed=int(np.log2(Nk)))
        xk_q = quantize_q15(xk)
        yk, bek = xfft(xk, 1)
        yk_true = yk * (2.0 ** bek) if fwd_sign == "y_hw * 2**(+be)" else yk * (2.0 ** (-bek))
        ref = np.fft.fft(xk_q)
        s = snr_db(ref, yk_true)
        ok = s >= 40.0
        size_ok &= ok
        print(f"  N={Nk:>6}: blk_exp={bek:>3}, SNR={s:6.2f} dB  {'OK' if ok else 'FAIL'}")
    results.append(("Runtime-N works for 256/4096/32768", size_ok, ""))

    # ----- Summary --------------------------------------------------------
    print("\n" + "=" * 72)
    print("SUMMARY")
    print("=" * 72)
    all_pass = True
    for name, ok, note in results:
        all_pass &= ok
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({note})" if note else ""))
    print("-" * 72)
    print("  Documented conventions:")
    print(f"    BFP recovery : y_true = {fwd_sign}")
    print(f"    IFFT norm    : {ifft_conv}")
    print("=" * 72)
    print("OVERALL:", "PASS" if all_pass else "FAIL")

    destroy_state()
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
