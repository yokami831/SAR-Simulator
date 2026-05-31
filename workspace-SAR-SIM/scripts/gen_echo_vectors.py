"""Generate xsim test vectors for the echo-synthesis datapath (echo_datapath.sv).

Writes (all under tmp/):
  echo_fir.hex       : N lines, 8 hex = {im16,re16} fir input, for $readmemh
  echo_coef.hex      : N lines, 8 hex = {im16,re16} Hcoef ROM (chirp_fft Q1.15)
  echo_P_expected.txt: STAGE 1 reference: 'k Pre Pim' (33-bit signed ints) per
                       bin from the hardware-faithful model.
  echo_s_expected.txt: STAGE 2 reference: 'k Sre Sim' (16-bit codes) + a trailing
                       '# be_inv <N>' line.
  echo_params.txt    : be_coef / shift / be_fwd / be_inv for the record.

Reuses the verified code<->float conventions from gen_xsim_vectors.py exactly.

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

N = 1024
BE_COEF = 7      # coefficient ROM block exponent (H peak ~0.38 FS, code ~12363)
SHIFT = 14       # 33->16 arithmetic right shift (Pq peak ~0.5 FS, code ~16360)


def pack_word(re_c: int, im_c: int) -> str:
    """{im16, re16} (im high), two's complement, 8 hex chars."""
    word = (m.to_u16(im_c) << 16) | m.to_u16(re_c)
    return f"{word:08X}"


def main() -> None:
    fir = m.make_fir(N)
    chirp = m.make_ref_chirp(N)

    # --- fir input hex (pre-quantized Q1.15 codes) ---
    fir_lines = []
    for k in range(N):
        re_c = m.code_from_q15(float(fir.real[k]))
        im_c = m.code_from_q15(float(fir.imag[k]))
        fir_lines.append(pack_word(re_c, im_c))
    (TMP / "echo_fir.hex").write_text("\n".join(fir_lines) + "\n")

    # --- coefficient ROM hex (chirp_fft Q1.15 codes at be_coef) ---
    Hre, Him, be_chirp = m.build_coef_rom(chirp, BE_COEF)
    coef_lines = [pack_word(int(Hre[k]), int(Him[k])) for k in range(N)]
    (TMP / "echo_coef.hex").write_text("\n".join(coef_lines) + "\n")

    # --- run the hardware-faithful model ---
    s_codes, dbg = m.echo_datapath(fir, chirp, N, be_coef=BE_COEF, shift=SHIFT,
                                   verbose=True)

    # STAGE 1 reference: cmpy product P (33-bit) per bin
    p_lines = [f"{k} {int(dbg['Pre'][k])} {int(dbg['Pim'][k])}" for k in range(N)]
    (TMP / "echo_P_expected.txt").write_text("\n".join(p_lines) + "\n")

    # STAGE 2 reference: final s_raw 16-bit codes + be_inv
    s_lines = [f"{k} {int(dbg['Sre'][k])} {int(dbg['Sim'][k])}" for k in range(N)]
    s_lines.append(f"# be_inv {dbg['be_inv']}")
    (TMP / "echo_s_expected.txt").write_text("\n".join(s_lines) + "\n")

    (TMP / "echo_params.txt").write_text(
        f"N {N}\nbe_coef {BE_COEF}\nshift {SHIFT}\n"
        f"be_fwd {dbg['be_fwd']}\nbe_inv {dbg['be_inv']}\nbe_chirp {be_chirp}\n"
    )

    print(f"N={N} be_coef={BE_COEF} shift={SHIFT}")
    print(f"be_fwd={dbg['be_fwd']} be_inv={dbg['be_inv']}")
    print(f"H_peak={dbg['H_peak']} F_peak={dbg['F_peak']} "
          f"P_peak={dbg['P_peak']} Pq_peak={dbg['Pq_peak']}")
    print(f"s_raw code peak={int(np.max(np.abs(np.concatenate([dbg['Sre'],dbg['Sim']]))))}")
    print("wrote:", TMP / "echo_fir.hex", TMP / "echo_coef.hex",
          TMP / "echo_P_expected.txt", TMP / "echo_s_expected.txt", sep="\n  ")


if __name__ == "__main__":
    main()
