// Verilator C++ testbench for SeqFFT.
// Protocol (stdin → DUT → stdout, all binary):
//   stdin : N pairs of (re:int16_le, im:int16_le)  -- Q1.15 inputs
//   stdout: N pairs of (re:int32_le, im:int32_le)  -- Q(WG).15 outputs (WG-bit signed,
//                                                     sign-extended into int32)
// Bit-reverse on input is done in this testbench (matches the FFT's expected
// DIT input ordering).
#include <verilated.h>
#include <cstdio>
#include <cstdint>
#include <vector>
#include <cstring>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

// Verilator generates Vtop.h via --prefix Vtop
#include "Vtop.h"

// Required by Verilator's verilated.cpp (used for $time / VCD timestamps; we
// don't dump waves so 0 is fine).
double sc_time_stamp() { return 0; }

static int log2_int(int n) {
    int k = 0;
    while ((1 << k) < n) ++k;
    return k;
}

static int bitrev(int i, int log_n) {
    int r = 0;
    for (int k = 0; k < log_n; ++k) {
        if (i & (1 << k)) r |= 1 << (log_n - 1 - k);
    }
    return r;
}

static void tick(Vtop* dut) {
    dut->clk = 0; dut->eval();
    dut->clk = 1; dut->eval();
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);

#ifdef _WIN32
    // Ensure no CR/LF translation on stdin/stdout — pure binary IO.
    _setmode(_fileno(stdin),  _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    // FFT_N must match the Amaranth export
    const int N = std::atoi(std::getenv("FFT_N") ? std::getenv("FFT_N") : "64");
    const int LOG_N = log2_int(N);

    // Read N complex int16 pairs from stdin (binary)
    std::vector<int16_t> in_re(N), in_im(N);
    for (int i = 0; i < N; ++i) {
        int16_t v;
        if (std::fread(&v, 2, 1, stdin) != 1) { std::fprintf(stderr, "[tb] stdin re EOF at %d\n", i); return 2; }
        in_re[i] = v;
        if (std::fread(&v, 2, 1, stdin) != 1) { std::fprintf(stderr, "[tb] stdin im EOF at %d\n", i); return 2; }
        in_im[i] = v;
    }

    Vtop* dut = new Vtop;

    // Reset
    dut->rst = 1; dut->start = 0; dut->load_we = 0;
    dut->load_addr = 0; dut->load_data_re = 0; dut->load_data_im = 0;
    for (int i = 0; i < 8; ++i) tick(dut);
    dut->rst = 0;
    tick(dut); tick(dut);

    // Pre-load RAM at bit-reversed addresses
    for (int i = 0; i < N; ++i) {
        int br = bitrev(i, LOG_N);
        dut->load_addr = br;
        // Load_data_re/im are WG bits wide; sign-extend int16 into uint32 bit pattern
        // verilator represents these as packed CData/SData/IData; just write the value.
        dut->load_data_re = (uint32_t)(int32_t)in_re[i];
        dut->load_data_im = (uint32_t)(int32_t)in_im[i];
        dut->load_we = 1;
        tick(dut);
    }
    dut->load_we = 0;
    tick(dut); tick(dut);

    // Start
    dut->start = 1; tick(dut); dut->start = 0;

    // Wait for done (busy → 0)
    int max_cycles = 4 * (N / 2) * LOG_N + 200;
    int waited = 0;
    while (true) {
        tick(dut); ++waited;
        if (!dut->busy) break;
        if (waited > max_cycles) { std::fprintf(stderr, "[tb] FFT didn't finish in %d cycles\n", max_cycles); delete dut; return 3; }
    }

    // Drain output (natural order)
    const int WG = 16 + LOG_N;
    const uint32_t signbit = 1u << (WG - 1);
    const uint32_t mask = (WG == 32) ? 0xFFFFFFFFu : ((1u << WG) - 1u);
    for (int i = 0; i < N; ++i) {
        dut->load_addr = i;
        tick(dut); tick(dut); // 1-cycle read latency + 1 settle
        uint32_t re_u = (uint32_t)dut->read_data_re & mask;
        uint32_t im_u = (uint32_t)dut->read_data_im & mask;
        int32_t re = (re_u & signbit) ? (int32_t)(re_u | ~mask) : (int32_t)re_u;
        int32_t im = (im_u & signbit) ? (int32_t)(im_u | ~mask) : (int32_t)im_u;
        std::fwrite(&re, 4, 1, stdout);
        std::fwrite(&im, 4, 1, stdout);
    }

    std::fflush(stdout);
    std::fprintf(stderr, "[tb] N=%d cycles_compute=%d\n", N, waited);
    delete dut;
    return 0;
}
