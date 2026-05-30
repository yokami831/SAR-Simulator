"""Generate xsim test vectors for xfft_0 RTL vs C-model bit-exactness check.

Builds a deterministic complex input of length N=1024, pre-quantized to Q1.15,
writes:
  tmp/xfft_in.hex        : 1024 lines, 8 hex chars each = {im16, re16} (two's comp,
                           im in high 16 bits) for $readmemh.
  tmp/xfft_expected.txt  : 'index re_code im_code' per line + a trailing
                           '# blk_exp <N>' line. re_code/im_code are the 16-bit
                           integer bus codes the IP should emit (C-model RAW
                           BFP-normalized output * 32768, truncated toward zero).

Run with .venv\\Scripts\\python.exe.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import xfft_cmodel  # noqa: E402

ROOT = HERE.parent.parent          # d:/kamijo/HiyoCanvas
TMP = ROOT / "tmp"
TMP.mkdir(exist_ok=True)

N = 1024


def to_u16(code: int) -> int:
    """Map a signed 16-bit integer code to its unsigned two's-complement value."""
    return code & 0xFFFF


def code_from_q15(v: float) -> int:
    """Convert a [-1,1) float (Q1.15 domain) to its signed 16-bit integer code.

    The C-model datapath truncates toward zero; the bus value is value*32768 as a
    16-bit two's-complement integer. We truncate toward zero to match.
    """
    c = int(np.trunc(v * 32768.0))
    # Saturate into signed 16-bit range just in case (BFP output should be in
    # [-1, 1) so this never triggers, but be safe).
    if c > 32767:
        c = 32767
    if c < -32768:
        c = -32768
    return c


def main() -> None:
    # Deterministic input: sum of two tones + a small DC, scaled to peak ~0.3.
    n = np.arange(N)
    x = (np.cos(2 * np.pi * 17 * n / N)
         + 0.5 * np.cos(2 * np.pi * 123 * n / N + 0.7)
         + 1j * (np.sin(2 * np.pi * 41 * n / N)
                 - 0.3 * np.sin(2 * np.pi * 200 * n / N)))
    peak = np.max(np.abs(x))
    x = x / peak * 0.3                      # peak magnitude ~0.3

    xq = xfft_cmodel.quantize_q15(x)        # complex128, Q1.15 truncated

    # --- write input hex: {im16, re16}, im in high 16 bits ---
    in_lines = []
    for k in range(N):
        re_c = code_from_q15(xq.real[k])
        im_c = code_from_q15(xq.imag[k])
        word = (to_u16(im_c) << 16) | to_u16(re_c)
        in_lines.append(f"{word:08X}")
    (TMP / "xfft_in.hex").write_text("\n".join(in_lines) + "\n")

    # --- run C-model (forward FFT) on the SAME pre-quantized input ---
    y, blk_exp = xfft_cmodel.xfft(xq, direction=1)   # y is RAW BFP output in [-1,1)

    exp_lines = []
    for k in range(N):
        re_c = code_from_q15(float(y.real[k]))
        im_c = code_from_q15(float(y.imag[k]))
        exp_lines.append(f"{k} {re_c} {im_c}")
    exp_lines.append(f"# blk_exp {blk_exp}")
    (TMP / "xfft_expected.txt").write_text("\n".join(exp_lines) + "\n")

    print(f"N={N}")
    print(f"input peak (post-q) = {np.max(np.abs(xq)):.6f}")
    print(f"blk_exp = {blk_exp}")
    print(f"output |y| max (raw) = {np.max(np.abs(y)):.6f}")
    print(f"wrote {TMP / 'xfft_in.hex'}")
    print(f"wrote {TMP / 'xfft_expected.txt'}")


if __name__ == "__main__":
    main()
