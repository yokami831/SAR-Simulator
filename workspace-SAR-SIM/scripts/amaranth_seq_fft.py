"""
Sequential radix-2 DIT FFT in Amaranth.

Architecture (single butterfly, in-place RAM, 3-cycle butterfly):
  - 2 Memories (re, im) of N words, signed(WG) each — in-place FFT storage
  - Twiddle ROM (re, im) of N/2 words, Q1.15
  - Control FSM cycles through stage = 0..log2(N)-1 and butterfly = 0..N/2-1
  - Each butterfly: cycle 0 = read pair (a, b); cycle 1 = compute a+wb, a-wb; cycle 2 = write back

Interface (block-based, simple for HIL sim):
  start         : pulse high to begin, after RAM is pre-loaded
  done          : high when FFT complete; output is available in RAM
  load_addr     : address for testbench to read/write RAM directly
  load_we       : write-enable for pre-loading input
  load_data_re, load_data_im : data lanes for write
  read_data_re, read_data_im : output lanes for read

Verification: drive a random Q1.15 complex vector, compare with numpy.fft.fft.
"""
import numpy as np
import time
from amaranth import Module, Signal, Elaboratable, signed, unsigned, Cat
from amaranth.lib import memory
from amaranth.sim import Simulator

# Constants
Q15 = 1 << 15


class SeqFFT(Elaboratable):
    def __init__(self, N=64, W_IN=16):
        self.N = N
        self.LOG_N = (N - 1).bit_length()
        self.W_IN = W_IN
        self.WG = W_IN + self.LOG_N

        # Twiddle factors W_N^k = exp(-j 2π k / N), k = 0..N/2-1, Q1.15
        # Computed per-instance so depth matches N.
        self.TWID_RE = [int(round(np.cos(-2 * np.pi * k / N) * (Q15 - 1))) for k in range(N // 2)]
        self.TWID_IM = [int(round(np.sin(-2 * np.pi * k / N) * (Q15 - 1))) for k in range(N // 2)]

        # Control / status
        self.start = Signal()
        self.done  = Signal()
        self.busy  = Signal()

        # External RAM access (for testbench pre-load and result read-out)
        self.load_addr     = Signal(unsigned(self.LOG_N))
        self.load_we       = Signal()
        self.load_data_re  = Signal(signed(self.WG))
        self.load_data_im  = Signal(signed(self.WG))
        self.read_data_re  = Signal(signed(self.WG))
        self.read_data_im  = Signal(signed(self.WG))

    def elaborate(self, platform):
        m = Module()

        # ---- Memories ----
        m.submodules.mem_re = mem_re = memory.Memory(
            shape=signed(self.WG), depth=self.N, init=[0] * self.N)
        m.submodules.mem_im = mem_im = memory.Memory(
            shape=signed(self.WG), depth=self.N, init=[0] * self.N)

        # Two read ports (port A reads addr_a, port B reads addr_b)
        rd_re_a = mem_re.read_port(domain="sync")
        rd_im_a = mem_im.read_port(domain="sync")
        rd_re_b = mem_re.read_port(domain="sync")
        rd_im_b = mem_im.read_port(domain="sync")

        # Two write ports (write back a' and b')
        wr_re_a = mem_re.write_port(domain="sync")
        wr_im_a = mem_im.write_port(domain="sync")
        wr_re_b = mem_re.write_port(domain="sync")
        wr_im_b = mem_im.write_port(domain="sync")

        # ---- Twiddle ROM (initial-loaded constants) ----
        m.submodules.rom_tre = rom_tre = memory.Memory(
            shape=signed(self.W_IN), depth=self.N // 2, init=self.TWID_RE)
        m.submodules.rom_tim = rom_tim = memory.Memory(
            shape=signed(self.W_IN), depth=self.N // 2, init=self.TWID_IM)
        rd_tre = rom_tre.read_port(domain="sync")
        rd_tim = rom_tim.read_port(domain="sync")

        # ---- Control: stage / butterfly counters ----
        stage  = Signal(unsigned(self.LOG_N + 1))   # 0..log2(N)
        bf_idx = Signal(unsigned(self.LOG_N))       # 0..N/2-1
        phase  = Signal(unsigned(2))                # 0=read 1=compute 2=write
        running = Signal()

        # Compute addr_a, addr_b, twid_idx for the current (stage, bf_idx)
        # Butterfly at stage s: distance between pair = 2^s
        #   - group size = 2^(s+1)
        #   - within group, j = bf_idx % 2^s, group_id = bf_idx // 2^s
        #   - addr_a = group_id * 2^(s+1) + j
        #   - addr_b = addr_a + 2^s
        # Twiddle index = j * (N / 2^(s+1)) = j << (LOG_N - s - 1)
        s_pow      = Signal(unsigned(self.LOG_N))         # 2^stage
        twid_shift = Signal(unsigned(self.LOG_N))         # LOG_N - stage - 1

        addr_a   = Signal(unsigned(self.LOG_N))
        addr_b   = Signal(unsigned(self.LOG_N))
        twid_idx = Signal(unsigned(self.LOG_N - 1))       # 0..N/2-1

        j        = Signal(unsigned(self.LOG_N))
        group_id = Signal(unsigned(self.LOG_N))

        # bit-mask: j = bf_idx & (2^s - 1); group_id = bf_idx >> s
        # implemented combinationally on stage
        with m.Switch(stage):
            for s in range(self.LOG_N):
                with m.Case(s):
                    m.d.comb += [
                        s_pow.eq(1 << s),
                        twid_shift.eq(self.LOG_N - s - 1),
                        j.eq(bf_idx & ((1 << s) - 1) if s > 0 else 0),
                        group_id.eq(bf_idx >> s),
                        addr_a.eq((bf_idx >> s) << (s + 1) | (bf_idx & ((1 << s) - 1) if s > 0 else 0)),
                        addr_b.eq(((bf_idx >> s) << (s + 1) | (bf_idx & ((1 << s) - 1) if s > 0 else 0)) + (1 << s)),
                        twid_idx.eq((bf_idx & ((1 << s) - 1) if s > 0 else 0) << (self.LOG_N - s - 1)),
                    ]

        # ---- Read addresses (drive ports during phase 0) ----
        # During pre-load (running=0), use load_addr; otherwise use compute addr_a/b
        m.d.comb += [
            rd_re_a.addr.eq(addr_a),
            rd_im_a.addr.eq(addr_a),
            rd_re_b.addr.eq(addr_b),
            rd_im_b.addr.eq(addr_b),
            rd_tre.addr.eq(twid_idx),
            rd_tim.addr.eq(twid_idx),
        ]
        # External read port (testbench post-FFT readout): route addr through rd_re_a only when idle
        # We use a separate read mux: if running == 0 and load_we == 0, read_data follows load_addr
        # For simplicity, allow read after done with load_addr selecting the address
        with m.If(~running):
            m.d.comb += [
                rd_re_a.addr.eq(self.load_addr),
                rd_im_a.addr.eq(self.load_addr),
            ]
        m.d.comb += [
            self.read_data_re.eq(rd_re_a.data),
            self.read_data_im.eq(rd_im_a.data),
        ]

        # ---- Pre-load writes (testbench drives load_we) ----
        # When not running, load_we routes to mem write port a with load_addr
        # When running, write ports come from butterfly result
        a_q_re = Signal(signed(self.WG + 1))   # +1 for add growth
        a_q_im = Signal(signed(self.WG + 1))
        b_q_re = Signal(signed(self.WG + 1))
        b_q_im = Signal(signed(self.WG + 1))

        with m.If(~running):
            m.d.comb += [
                wr_re_a.addr.eq(self.load_addr),
                wr_im_a.addr.eq(self.load_addr),
                wr_re_a.data.eq(self.load_data_re),
                wr_im_a.data.eq(self.load_data_im),
                wr_re_a.en.eq(self.load_we),
                wr_im_a.en.eq(self.load_we),
                wr_re_b.en.eq(0),
                wr_im_b.en.eq(0),
            ]
        with m.Else():
            # During compute, write back at phase 2
            m.d.comb += [
                wr_re_a.addr.eq(addr_a),
                wr_im_a.addr.eq(addr_a),
                wr_re_b.addr.eq(addr_b),
                wr_im_b.addr.eq(addr_b),
                wr_re_a.data.eq(a_q_re),
                wr_im_a.data.eq(a_q_im),
                wr_re_b.data.eq(b_q_re),
                wr_im_b.data.eq(b_q_im),
                wr_re_a.en.eq(phase == 2),
                wr_im_a.en.eq(phase == 2),
                wr_re_b.en.eq(phase == 2),
                wr_im_b.en.eq(phase == 2),
            ]

        # ---- Butterfly compute (registered intermediate) ----
        # Latch read values at phase 1
        a_re_r = Signal(signed(self.WG))
        a_im_r = Signal(signed(self.WG))
        b_re_r = Signal(signed(self.WG))
        b_im_r = Signal(signed(self.WG))
        tw_re_r = Signal(signed(self.W_IN))
        tw_im_r = Signal(signed(self.W_IN))

        with m.If(phase == 1):
            m.d.sync += [
                a_re_r.eq(rd_re_a.data),
                a_im_r.eq(rd_im_a.data),
                b_re_r.eq(rd_re_b.data),
                b_im_r.eq(rd_im_b.data),
                tw_re_r.eq(rd_tre.data),
                tw_im_r.eq(rd_tim.data),
            ]

        # Combinational complex multiply: wb = w * b
        # Q(stage+1).15 × Q1.15 = Q(stage+2).30 → shift right 15 to get Q(stage+2).15
        wb_re_full = Signal(signed(self.WG + self.W_IN + 1))
        wb_im_full = Signal(signed(self.WG + self.W_IN + 1))
        m.d.comb += [
            wb_re_full.eq(b_re_r * tw_re_r - b_im_r * tw_im_r),
            wb_im_full.eq(b_re_r * tw_im_r + b_im_r * tw_re_r),
        ]
        wb_re = Signal(signed(self.WG + 1))
        wb_im = Signal(signed(self.WG + 1))
        m.d.comb += [
            wb_re.eq(wb_re_full >> 15),
            wb_im.eq(wb_im_full >> 15),
            a_q_re.eq(a_re_r + wb_re),
            a_q_im.eq(a_im_r + wb_im),
            b_q_re.eq(a_re_r - wb_re),
            b_q_im.eq(a_im_r - wb_im),
        ]

        # ---- Phase / counter advance ----
        with m.If(self.start & ~running):
            m.d.sync += [
                running.eq(1),
                stage.eq(0),
                bf_idx.eq(0),
                phase.eq(0),
            ]
        with m.Elif(running):
            m.d.sync += phase.eq(phase + 1)
            with m.If(phase == 2):
                m.d.sync += phase.eq(0)
                with m.If(bf_idx == (self.N // 2 - 1)):
                    m.d.sync += bf_idx.eq(0)
                    with m.If(stage == self.LOG_N - 1):
                        # done
                        m.d.sync += [running.eq(0), stage.eq(0)]
                    with m.Else():
                        m.d.sync += stage.eq(stage + 1)
                with m.Else():
                    m.d.sync += bf_idx.eq(bf_idx + 1)

        m.d.comb += [
            self.busy.eq(running),
            self.done.eq(~running & (stage == 0) & (bf_idx == 0)),  # stays high after completion
        ]
        return m


# =====================================================================
# Verification
# =====================================================================

def to_q15(x):
    return int(round(np.clip(x, -1.0, 1.0 - 1.0 / Q15) * Q15))


def bitrev(i, log_n):
    r = 0
    for k in range(log_n):
        if i & (1 << k):
            r |= 1 << (log_n - 1 - k)
    return r


def run_test(N_test=64, seed=0):
    rng = np.random.default_rng(seed)
    x = (rng.standard_normal(N_test) + 1j * rng.standard_normal(N_test)) * 0.1

    # Quantize input to Q1.15
    x_q15_re = [to_q15(v.real) for v in x]
    x_q15_im = [to_q15(v.imag) for v in x]
    x_q15 = np.array([(re + 1j * im) / Q15 for re, im in zip(x_q15_re, x_q15_im)],
                     dtype=np.complex128)

    # numpy reference (on the quantized input)
    ref = np.fft.fft(x_q15)

    # Run Amaranth simulation
    dut = SeqFFT(N=N_test, W_IN=16)
    sim = Simulator(dut)
    sim.add_clock(1e-6)   # 1 MHz nominal — irrelevant for correctness

    captured_re = [0] * N_test
    captured_im = [0] * N_test

    async def tb(ctx):
        # 1) Pre-load: write x_q15 into RAM at BIT-REVERSED addresses (DIT format)
        log_n = (N_test - 1).bit_length()
        for i in range(N_test):
            br = bitrev(i, log_n)
            ctx.set(dut.load_addr, br)
            ctx.set(dut.load_data_re, x_q15_re[i])
            ctx.set(dut.load_data_im, x_q15_im[i])
            ctx.set(dut.load_we, 1)
            await ctx.tick()
        ctx.set(dut.load_we, 0)
        await ctx.tick()

        # 2) Start FFT
        ctx.set(dut.start, 1)
        await ctx.tick()
        ctx.set(dut.start, 0)

        # 3) Wait for done
        max_cycles = 3 * (N_test // 2) * log_n + 100
        cycles_used = 0
        while True:
            cycles_used += 1
            await ctx.tick()
            busy = ctx.get(dut.busy)
            if busy == 0:
                break
            if cycles_used > max_cycles:
                raise RuntimeError(f"FFT did not finish in {max_cycles} cycles")

        # 4) Drain: read out all N words
        await ctx.tick()
        for i in range(N_test):
            ctx.set(dut.load_addr, i)
            await ctx.tick()
            await ctx.tick()   # let the registered read settle (1 cycle latency)
            captured_re[i] = ctx.get(dut.read_data_re)
            captured_im[i] = ctx.get(dut.read_data_im)

    sim.add_testbench(tb)
    t_start = time.monotonic()
    sim.run()
    t_elapsed = time.monotonic() - t_start

    hw = np.array([captured_re[i] / Q15 + 1j * captured_im[i] / Q15 for i in range(N_test)])
    err = np.abs(hw - ref)
    sig_rms = np.sqrt(np.mean(np.abs(ref) ** 2))
    err_rms = np.sqrt(np.mean(err ** 2))
    snr = 20 * np.log10(sig_rms / (err_rms + 1e-30))
    print(f'N={N_test}  sim_time={t_elapsed:.2f}s  max|err|={err.max():.5g}  rms_err={err_rms:.5g}  SNR={snr:.1f} dB')
    if N_test <= 16:
        for i in range(N_test):
            print(f'  X[{i}]: ref=({ref[i].real:+.4f},{ref[i].imag:+.4f})  hw=({hw[i].real:+.4f},{hw[i].imag:+.4f})')
    return snr


if __name__ == '__main__':
    run_test(N_test=64, seed=0)
