// Full SAR ECHO-SYNTHESIS datapath (reflection-wave / HIL target simulator).
//
//   fir (Q1.15) -> xfft_fwd (forward FFT) -> F[k] + be_fwd
//               -> cmpy: F[k] * Hcoef[k]  -> P[k] (33-bit exact)
//               -> shift+truncate 33->16  -> Pq[k] (Q1.15)
//               -> xfft_inv (inverse FFT) -> s_raw[n] (16-bit) + be_inv
//
// Hcoef = chirp_fft = FORWARD chirp spectrum (NOT conjugate / matched filter):
// this synthesizes the radar ECHO, it does not range-compress.
//
// The 33->16 stage = arithmetic right shift by SHIFT then take low 16 bits
// (truncate toward -inf, two's-complement wrap) = RTL  $signed(P >>> SHIFT)[15:0].
//
// cmpy_0 is NonBlocking fixed-latency (no tready/tlast). To absorb any xfft_inv
// backpressure, Pq is buffered into a RAM (N entries, addressed by the product
// beat = natural-order bin), then streamed into xfft_inv respecting its tready.
//
// Coefficient ROM bin k aligns with xfft_fwd natural-order output bin k.
`timescale 1ns / 1ps

module echo_datapath #(
    parameter integer N          = 1024,
    parameter integer NFFT       = 10,        // log2(N)
    parameter integer SHIFT      = 14,        // 33->16 arithmetic right shift
    parameter [15:0]  CONFIG_FWD = 16'h010A,  // FWD(bit8)=1 | NFFT=10
    parameter [15:0]  CONFIG_INV = 16'h000A   // INV(bit8)=0 | NFFT=10
) (
    input  wire        aclk,
    input  wire        arst,                  // synchronous reset of internal FSM/counters
    // fir input (AXIS slave to xfft_fwd)
    input  wire        s_axis_data_tvalid,
    input  wire [31:0] s_axis_data_tdata,
    input  wire        s_axis_data_tlast,
    output wire        s_axis_data_tready,
    // config drive (slave to xfft_fwd config)
    input  wire        s_axis_config_tvalid,
    input  wire [15:0] s_axis_config_tdata,
    output wire        s_axis_config_tready,
    // s_raw output (xfft_inv master)
    output wire [31:0] m_axis_data_tdata,     // {im16, re16} Q1.15 codes
    output wire [7:0]  m_axis_data_tuser,     // be_inv block exponent
    output wire        m_axis_data_tvalid,
    output wire        m_axis_data_tlast,
    input  wire        m_axis_data_tready,
    // debug
    output wire [7:0]  dbg_be_fwd
);

  // =====================================================================
  // coefficient ROM (chirp_fft Q1.15 codes, {im16,re16})
  // =====================================================================
  (* rom_style = "block" *) reg [31:0] coef_rom [0:N-1];
  integer ri;
  initial begin
    for (ri = 0; ri < N; ri = ri + 1) coef_rom[ri] = 32'h0;
    $readmemh("d:/kamijo/HiyoCanvas/tmp/echo_coef.hex", coef_rom);
  end

  // =====================================================================
  // STAGE 1: xfft_fwd
  // =====================================================================
  wire [31:0] fwd_m_tdata;
  wire [7:0]  fwd_m_tuser;
  wire        fwd_m_tvalid;
  wire        fwd_m_tlast;
  wire        fwd_m_tready = 1'b1;     // always consume FFT output (cmpy can't backpressure)

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

  assign dbg_be_fwd = fwd_m_tuser;

  // ROM addressed by FFT-output beat (natural-order bin)
  reg [15:0] fwd_beat;
  always @(posedge aclk) begin
    if (arst)
      fwd_beat <= 16'd0;
    else if (fwd_m_tvalid && fwd_m_tready) begin
      if (fwd_m_tlast) fwd_beat <= 16'd0;
      else             fwd_beat <= fwd_beat + 16'd1;
    end
  end
  wire [31:0] rom_word = coef_rom[fwd_beat[NFFT-1:0]];

  // =====================================================================
  // cmpy_0: P = F * Hcoef  (33-bit exact, NonBlocking fixed latency)
  // =====================================================================
  wire        prod_tvalid;
  wire [79:0] prod_tdata;
  cmpy_0 u_cmpy (
    .aclk               (aclk),
    .s_axis_a_tvalid    (fwd_m_tvalid),
    .s_axis_a_tdata     (fwd_m_tdata),
    .s_axis_b_tvalid    (fwd_m_tvalid),
    .s_axis_b_tdata     (rom_word),
    .m_axis_dout_tvalid (prod_tvalid),
    .m_axis_dout_tdata  (prod_tdata)
  );

  // 33-bit (sign-extended to 40) product components
  wire signed [39:0] P_re = $signed(prod_tdata[39:0]);
  wire signed [39:0] P_im = $signed(prod_tdata[79:40]);

  // 33->16 arithmetic right shift + truncate to 16-bit Q1.15
  wire signed [39:0] Pq_re_full = P_re >>> SHIFT;
  wire signed [39:0] Pq_im_full = P_im >>> SHIFT;
  wire [15:0] Pq_re = Pq_re_full[15:0];
  wire [15:0] Pq_im = Pq_im_full[15:0];
  wire [31:0] Pq_word = {Pq_im, Pq_re};

  // =====================================================================
  // Pq buffer RAM (decouples NonBlocking cmpy from xfft_inv backpressure)
  // =====================================================================
  reg [31:0] pq_ram [0:N-1];
  integer ii;
  initial begin
    for (ii = 0; ii < N; ii = ii + 1) pq_ram[ii] = 32'h0;
  end

  reg [15:0] prod_beat;     // write address = product beat (natural-order bin)
  reg        pq_full;       // all N products buffered
  always @(posedge aclk) begin
    if (arst) begin
      prod_beat <= 16'd0;
      pq_full   <= 1'b0;
    end else if (prod_tvalid && !pq_full) begin
      pq_ram[prod_beat[NFFT-1:0]] <= Pq_word;
      if (prod_beat == N-1) begin
        prod_beat <= 16'd0;
        pq_full   <= 1'b1;
      end else begin
        prod_beat <= prod_beat + 16'd1;
      end
    end
  end

  // =====================================================================
  // xfft_inv input streamer (reads pq_ram, respects inv tready)
  // =====================================================================
  reg         inv_cfg_done;
  reg         inv_cfg_tvalid;
  reg  [15:0] inv_rd_addr;
  reg         inv_streaming;
  reg         inv_data_tvalid;

  wire        inv_cfg_tready;
  wire        inv_data_tready;

  // config: present CONFIG_INV once after reset until accepted
  always @(posedge aclk) begin
    if (arst) begin
      inv_cfg_tvalid <= 1'b1;
      inv_cfg_done   <= 1'b0;
    end else if (inv_cfg_tvalid && inv_cfg_tready) begin
      inv_cfg_tvalid <= 1'b0;
      inv_cfg_done   <= 1'b1;
    end
  end

  // stream pq_ram[0..N-1] into xfft_inv once buffered + configured
  wire inv_beat_fire = inv_data_tvalid && inv_data_tready;
  always @(posedge aclk) begin
    if (arst) begin
      inv_rd_addr     <= 16'd0;
      inv_streaming   <= 1'b0;
      inv_data_tvalid <= 1'b0;
    end else begin
      if (!inv_streaming) begin
        if (pq_full && inv_cfg_done) begin
          inv_streaming   <= 1'b1;
          inv_data_tvalid <= 1'b1;
          inv_rd_addr     <= 16'd0;
        end
      end else begin
        if (inv_beat_fire) begin
          if (inv_rd_addr == N-1) begin
            inv_streaming   <= 1'b0;
            inv_data_tvalid <= 1'b0;
          end else begin
            inv_rd_addr <= inv_rd_addr + 16'd1;
          end
        end
      end
    end
  end

  wire [31:0] inv_data_tdata = pq_ram[inv_rd_addr[NFFT-1:0]];
  wire        inv_data_tlast = inv_streaming && (inv_rd_addr == N-1);

  wire [15:0] inv_cfg_tdata = CONFIG_INV;

  // unused status master channel: tready high
  wire [7:0]  inv_status_tdata;
  wire        inv_status_tvalid;
  wire        inv_status_tready = 1'b1;

  xfft_0 u_fft_inv (
    .aclk                        (aclk),
    .s_axis_config_tdata         (inv_cfg_tdata),
    .s_axis_config_tvalid        (inv_cfg_tvalid),
    .s_axis_config_tready        (inv_cfg_tready),
    .s_axis_data_tdata           (inv_data_tdata),
    .s_axis_data_tvalid          (inv_data_tvalid),
    .s_axis_data_tready          (inv_data_tready),
    .s_axis_data_tlast           (inv_data_tlast),
    .m_axis_data_tdata           (m_axis_data_tdata),
    .m_axis_data_tuser           (m_axis_data_tuser),
    .m_axis_data_tvalid          (m_axis_data_tvalid),
    .m_axis_data_tready          (m_axis_data_tready),
    .m_axis_data_tlast           (m_axis_data_tlast),
    .m_axis_status_tdata         (inv_status_tdata),
    .m_axis_status_tvalid        (inv_status_tvalid),
    .m_axis_status_tready        (inv_status_tready),
    .event_frame_started         (),
    .event_tlast_unexpected      (),
    .event_tlast_missing         (),
    .event_status_channel_halt   (),
    .event_data_in_channel_halt  (),
    .event_data_out_channel_halt ()
  );

endmodule
