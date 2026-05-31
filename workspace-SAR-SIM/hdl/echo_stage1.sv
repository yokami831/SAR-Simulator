// STAGE 1 bring-up wrapper for the echo-synthesis datapath.
//
// Validates: xfft_fwd (forward FFT of fir) + coefficient ROM sync + cmpy_0
// (F[k] * Hcoef[k]) + natural-order alignment.
//
// Exposes the cmpy 33-bit product P[k] (re/im) plus the FFT output codes and
// the ROM codes for that beat, so the testbench can dump them and compare to
// model_echo_datapath's F*Hcoef stage bit-exact.
//
// Coefficient ROM bin k aligns with xfft_fwd natural-order output bin k: the
// ROM is addressed by the FFT-output beat counter, presented on cmpy port B in
// the SAME cycle as the FFT output bin on port A (cmpy is NonBlocking, fixed
// latency, no tready/tlast).
`timescale 1ns / 1ps

module echo_stage1 #(
    parameter integer N      = 1024,
    parameter [15:0]  CONFIG_FWD = 16'h010A    // FWD(bit8)=1 | NFFT=10 (N=1024)
) (
    input  wire        aclk,
    // fir input (AXIS slave to xfft_fwd)
    input  wire        s_axis_data_tvalid,
    input  wire [31:0] s_axis_data_tdata,
    input  wire        s_axis_data_tlast,
    output wire        s_axis_data_tready,
    // config drive (slave to xfft_fwd config)
    input  wire        s_axis_config_tvalid,
    input  wire [15:0] s_axis_config_tdata,
    output wire        s_axis_config_tready,
    // cmpy product output (33-bit per component, sign-extended to 40 in 80-bit bus)
    output wire        prod_tvalid,
    output wire [39:0] prod_re,        // P_re (33-bit sign-extended)
    output wire [39:0] prod_im,        // P_im
    // observation: FFT output codes + ROM codes for the current product beat
    output wire [15:0] dbg_F_re,
    output wire [15:0] dbg_F_im,
    output wire [15:0] dbg_H_re,
    output wire [15:0] dbg_H_im,
    output wire [7:0]  dbg_be_fwd
);

  // ---- coefficient ROM (chirp_fft Q1.15 codes, {im16,re16}) ----
  (* rom_style = "block" *) reg [31:0] coef_rom [0:N-1];
  integer ri;
  initial begin
    for (ri = 0; ri < N; ri = ri + 1) coef_rom[ri] = 32'h0;
    $readmemh("d:/kamijo/HiyoCanvas/tmp/echo_coef.hex", coef_rom);
  end

  // ---- xfft_fwd ----
  wire [31:0] fwd_m_tdata;
  wire [7:0]  fwd_m_tuser;
  wire        fwd_m_tvalid;
  wire        fwd_m_tlast;
  wire        fwd_m_tready = 1'b1;     // we always consume the FFT output

  // unused status master channel: tready tied high (anti-pattern VIVADO-AXIS-001)
  wire [7:0]  fwd_status_tdata;
  wire        fwd_status_tvalid;
  wire        fwd_status_tready = 1'b1;

  xfft_0 u_fft_fwd (
    .aclk                        (aclk),
    .s_axis_config_tdata         (s_axis_config_tdata),
    .s_axis_config_tvalid        (s_axis_config_tvalid),
    .s_axis_config_tready        (s_axis_config_tready),
    .s_axis_data_tdata           (s_axis_data_tdata),
    .s_axis_data_tvalid          (s_axis_data_tvalid),
    .s_axis_data_tready          (s_axis_data_tready),
    .s_axis_data_tlast           (s_axis_data_tlast),
    .m_axis_data_tdata           (fwd_m_tdata),
    .m_axis_data_tuser           (fwd_m_tuser),
    .m_axis_data_tvalid          (fwd_m_tvalid),
    .m_axis_data_tready          (fwd_m_tready),
    .m_axis_data_tlast           (fwd_m_tlast),
    .m_axis_status_tdata         (fwd_status_tdata),
    .m_axis_status_tvalid        (fwd_status_tvalid),
    .m_axis_status_tready        (fwd_status_tready),
    .event_frame_started         (),
    .event_tlast_unexpected      (),
    .event_tlast_missing         (),
    .event_status_channel_halt   (),
    .event_data_in_channel_halt  (),
    .event_data_out_channel_halt ()
  );

  // ---- ROM addressing: count FFT output beats (natural-order bin index) ----
  reg [15:0] fwd_beat;
  always @(posedge aclk) begin
    if (fwd_m_tvalid && fwd_m_tready) begin
      if (fwd_m_tlast) fwd_beat <= 16'd0;
      else             fwd_beat <= fwd_beat + 16'd1;
    end
  end
  initial fwd_beat = 16'd0;

  wire [31:0] rom_word = coef_rom[fwd_beat[$clog2(N)-1:0]];

  // ---- cmpy_0: A = FFT output bin, B = ROM word, same cycle ----
  // cmpy is NonBlocking fixed-latency, no tready/tlast.
  wire [79:0] dout_tdata;
  cmpy_0 u_cmpy (
    .aclk               (aclk),
    .s_axis_a_tvalid    (fwd_m_tvalid),
    .s_axis_a_tdata     (fwd_m_tdata),
    .s_axis_b_tvalid    (fwd_m_tvalid),
    .s_axis_b_tdata     (rom_word),
    .m_axis_dout_tvalid (prod_tvalid),
    .m_axis_dout_tdata  (dout_tdata)
  );

  assign prod_re = dout_tdata[39:0];
  assign prod_im = dout_tdata[79:40];

  // ---- debug taps (registered to align with the A/B inputs presented) ----
  assign dbg_F_re   = fwd_m_tdata[15:0];
  assign dbg_F_im   = fwd_m_tdata[31:16];
  assign dbg_H_re   = rom_word[15:0];
  assign dbg_H_im   = rom_word[31:16];
  assign dbg_be_fwd = fwd_m_tuser;

endmodule
