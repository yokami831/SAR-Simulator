"""Generate per-N xsim test vectors for the RUNTIME-N echo-synthesis datapath
(echo_datapath_rt.sv / tb_echo_datapath_rt.sv).

For each N in N_LIST writes (all under tmp/):
  echo_fir_<N>.hex    : N lines, 8 hex = {im16,re16} fir input, for $readmemh
  echo_coef_<N>.hex   : N lines, 8 hex = {im16,re16} Hcoef ROM (chirp_fft Q1.15)
  echo_s_expected_<N>.txt : 'k Sre Sim' (16-bit codes) + trailing '# be_inv <N>'

Plus a single manifest the testbench reads to know what to run:
  echo_rt_manifest.txt : one line per N:
      <N> <NFFT> <SHIFT> <BE_COEF> <BE_FWD> <BE_INV>
  echo_rt_sizes.txt    : just the N values, one per line (TB convenience)

Reuses the bit-exact model_echo_datapath conventions exactly. The be_coef and
shift for each N are auto-chosen so the coefficient ROM peak and the post-shift
product peak both land near ~0.5 FS (no saturation, good headroom) -- the same
design target the fixed-N N=1024 vectors used (be_coef=7, shift=14).

Run with .venv\\Scripts\\python.exe.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import model_echo_datapath as m  # noqa: E402

ROOT = HERE.parent.parent          # d:/kamijo/HiyoCanvas
TMP = ROOT / "tmp"
TMP.mkdir(exist_ok=True)

N_LIST = [256, 1024, 4096]


def make_fir_n(N: int) -> np.ndarray:
    """Deterministic single-pulse scene impulse (Q1.15, peak ~0.3), N-scaled.

    Same style as model_echo_datapath.make_fir (clutter floor + a few bright
    scatterers, normalized to peak 0.3) but the scatterer positions scale with
    N so it works for any N (the model's make_fir hardcodes indices for
    N=1024). For N=1024 this reproduces make_fir's positions (100/400/777).
    """
    rng = np.random.default_rng(12345)
    fir = ((rng.standard_normal(N) + 1j * rng.standard_normal(N)) * 0.01).astype(np.complex64)
    # bright scatterers at the same FRACTIONAL positions as the N=1024 model
    fir[(100 * N) // 1024] += 0.25 + 0.10j
    fir[(400 * N) // 1024] += -0.18 + 0.20j
    fir[(777 * N) // 1024] += 0.15 - 0.22j
    peak = float(np.max(np.abs(fir)))
    fir = (fir / peak * 0.3).astype(np.complex64)
    return fir


def pack_word(re_c: int, im_c: int) -> str:
    """{im16, re16} (im high), two's complement, 8 hex chars."""
    word = (m.to_u16(im_c) << 16) | m.to_u16(re_c)
    return f"{word:08X}"


def choose_be_coef(ref_chirp: np.ndarray, N: int) -> int:
    """Pick a power-of-2 block exponent so the coefficient ROM peak code lands
    in a safe range (target ~0.3..0.5 FS, i.e. code ~9800..16384), no
    saturation. Search a small range and take the smallest be_coef whose peak
    code <= 16384 (and > 0)."""
    for be in range(0, 24):
        Hre, Him, _ = m.build_coef_rom(ref_chirp, be)
        peak = int(np.max(np.abs(np.concatenate([Hre, Him]))))
        if peak == 0:
            return be  # degenerate (shouldn't happen)
        if peak <= 16384:
            return be
    return 23


def choose_shift(Pre, Pim) -> int:
    """Pick the 33->16 arithmetic right shift so the post-shift product peak
    lands near ~0.5 FS (<= 16384, no saturation/wrap). The shifted peak is
    floor(P_peak / 2**shift); choose the smallest shift with shifted peak
    <= 16384."""
    Ppeak = int(np.max(np.abs(np.concatenate([np.asarray(Pre), np.asarray(Pim)]))))
    if Ppeak == 0:
        return 0
    for s in range(0, 33):
        if (Ppeak >> s) <= 16384:
            return s
    return 32


def gen_one(N: int):
    fir = make_fir_n(N)
    chirp = m.make_ref_chirp(N)

    NFFT = int(np.log2(N))
    assert (1 << NFFT) == N, f"N={N} not power of two"

    # --- choose be_coef from the coefficient ROM peak ---
    be_coef = choose_be_coef(chirp, N)
    Hre, Him, be_chirp = m.build_coef_rom(chirp, be_coef)

    # --- forward FFT of fir + cmpy to get the product peak for shift choice ---
    F_raw, be_fwd = m.xfft(fir, 1)
    Fre, Fim = m.codes_from_raw(F_raw)
    Pre, Pim = m.cmpy_int(Fre, Fim, Hre, Him)
    shift = choose_shift(Pre, Pim)

    # --- run the full bit-exact model with the chosen params ---
    s_codes, dbg = m.echo_datapath(fir, chirp, N, be_coef=be_coef, shift=shift,
                                   verbose=False)

    # --- fir input hex (pre-quantized Q1.15 codes) ---
    fir_lines = []
    for k in range(N):
        re_c = m.code_from_q15(float(fir.real[k]))
        im_c = m.code_from_q15(float(fir.imag[k]))
        fir_lines.append(pack_word(re_c, im_c))
    (TMP / f"echo_fir_{N}.hex").write_text("\n".join(fir_lines) + "\n")

    # --- coefficient ROM hex ---
    coef_lines = [pack_word(int(Hre[k]), int(Him[k])) for k in range(N)]
    (TMP / f"echo_coef_{N}.hex").write_text("\n".join(coef_lines) + "\n")

    # --- expected s_raw 16-bit codes + be_inv ---
    s_lines = [f"{k} {int(dbg['Sre'][k])} {int(dbg['Sim'][k])}" for k in range(N)]
    s_lines.append(f"# be_inv {dbg['be_inv']}")
    (TMP / f"echo_s_expected_{N}.txt").write_text("\n".join(s_lines) + "\n")

    s_peak = int(np.max(np.abs(np.concatenate([dbg['Sre'], dbg['Sim']]))))
    print(f"N={N:6d} NFFT={NFFT:2d} cfg_fwd=0x{(0x100|NFFT):04X} "
          f"cfg_inv=0x{NFFT:04X} be_coef={be_coef} shift={shift} "
          f"be_fwd={dbg['be_fwd']} be_inv={dbg['be_inv']} "
          f"H_peak={dbg['H_peak']} P_peak={dbg['P_peak']} "
          f"Pq_peak={dbg['Pq_peak']} s_peak={s_peak}")

    return (N, NFFT, shift, be_coef, dbg['be_fwd'], dbg['be_inv'])


def main() -> None:
    rows = [gen_one(N) for N in N_LIST]

    manifest = "\n".join(
        f"{N} {NFFT} {SHIFT} {BE_COEF} {BE_FWD} {BE_INV}"
        for (N, NFFT, SHIFT, BE_COEF, BE_FWD, BE_INV) in rows
    )
    (TMP / "echo_rt_manifest.txt").write_text(manifest + "\n")
    (TMP / "echo_rt_sizes.txt").write_text(
        "\n".join(str(r[0]) for r in rows) + "\n")

    print("\nmanifest (N NFFT SHIFT BE_COEF BE_FWD BE_INV):")
    print(manifest)
    print("\nwrote per-N files + echo_rt_manifest.txt to", TMP)


if __name__ == "__main__":
    main()
