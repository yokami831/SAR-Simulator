// RUNTIME-N SAR ECHO-SYNTHESIS datapath (reflection-wave / HIL target simulator).
//
// Same datapath as echo_datapath.sv but the transform length N is selectable
// at RUN TIME (power-of-2, 256..65536) instead of being a compile-time param.
//
//   fir (Q1.15) -> xfft_fwd (forward FFT) -> F[k] + be_fwd
//               -> cmpy: F[k] * Hcoef[k]  -> P[k] (33-bit exact)
//               -> shift+truncate 33->16  -> Pq[k] (Q1.15)
//               -> xfft_inv (inverse FFT) -> s_raw[n] (16-bit) + be_inv
//
// Hcoef = chirp_fft = FORWARD chirp spectrum (NOT conjugate / matched filter):
// this synthesizes the radar ECHO, it does not range-compress.
//
// Runtime knobs (latch them stable for the whole frame; the testbench / host
// sets them before streaming a frame and holds them):
//   * nfft_sel [4:0]  = log2(N).  Valid 8..16  ->  N = 256..65536.
//   * shift_sel[5:0]  = 33->16 arithmetic right shift amount.
//
// The xfft v9.1 IP is built with run_time_configurable_transform_length=true,
// block_floating_point scaling, natural order, 16-bit, transform_length=65536
// (max).  Its config word in BFP runtime-length mode is
//   {FWD_INV(bit8), NFFT[4:0]}    (no scaling schedule bits: BFP picks scaling)
// so:
//   config_fwd = (1<<8) | nfft_sel
//   config_inv = (0<<8) | nfft_sel
// We re-send BOTH config words at the start of every frame (config is cheap and
// must track the current N).
//
// Coefficient memory is a RUNTIME-WRITABLE BRAM sized for NMAX=65536, 32-bit
// {im16,re16} Q1.15.  In the real system the PS loads chirp_fft for the current
// N before processing; here the testbench preloads it per-N via the coef_we /
// coef_waddr / coef_wdata write port.  ROM read address wraps at the runtime N.
//
// cmpy_0 is NonBlocking fixed-latency (no tready/tlast). Pq is buffered into a
// RAM (N entries, addressed by the product beat = natural-order bin), then
// streamed into xfft_inv respecting its tready, exactly as the fixed-N version.
`timescale 1ns / 1ps

module echo_datapath_rt #(
    parameter integer NFFT_MAX = 16,           // log2(NMAX)
    parameter integer NMAX     = (1 << NFFT_MAX)
) (
    input  wire        aclk,
    input  wire        arst,                   // synchronous reset of internal FSM/counters

    // ---- runtime size / shift selection (hold stable across a frame) ----
    input  wire [4:0]  nfft_sel,               // log2(N), 8..16
    input  wire [5:0]  shift_sel,              // 33->16 arithmetic right shift

    // ---- coefficient BRAM write port (host / TB loads chirp_fft for cur N) ----
    input  wire                 coef_we,
    input  wire [NFFT_MAX-1:0]  coef_waddr,
    input  wire [31:0]          coef_wdata,    // {im16, re16} Q1.15

    // ---- fir input (AXIS slave to xfft_fwd) ----
    input  wire        s_axis_data_tvalid,
    input  wire [31:0] s_axis_data_tdata,
    input  wire        s_axis_data_tlast,
    output wire        s_axis_data_tready,

    // ---- frame start strobe: pulse 1 cycle to (re)send config for cur nfft_sel ----
    //  (assert with the size already valid on nfft_sel; the DUT latches N and
    //   drives BOTH xfft config channels.)  s_axis_data may begin streaming any
    //   time after fwd config is accepted.
    input  wire        frame_start,

    // ---- s_raw output (xfft_inv master) ----
    output wire [31:0] m_axis_data_tdata,      // {im16, re16} Q1.15 codes
    output wire [7:0]  m_axis_data_tuser,      // be_inv block exponent
    output wire        m_axis_data_tvalid,
    output wire        m_axis_data_tlast,
    input  wire        m_axis_data_tready,

    // ---- debug ----
    output wire [7:0]  dbg_be_fwd,
    output wire        dbg_fwd_cfg_tvalid,
    output wire        dbg_fwd_cfg_tready,
    output wire        dbg_inv_cfg_done,
    output wire        dbg_pq_full,
    output wire        dbg_fwd_m_tvalid,
    output wire        dbg_fwd_m_tlast,
    output wire        dbg_inv_cfg_tvalid,
    output wire        dbg_inv_cfg_tready,
    output wire [15:0] dbg_inv_cfg_tdata,
    output wire        dbg_inv_data_fire,
    output wire        dbg_inv_data_tlast
);

  // =====================================================================
  // Runtime size: latch N (and shift) at frame_start, derive config words.
  // =====================================================================
  reg [4:0]  nfft_q;        // latched log2(N) for the running frame
  reg [5:0]  shift_q;       // latched shift
  reg [16:0] N_q;           // latched N = 1<<nfft_q (need 17 bits for 65536)

  // index width: addresses/counters range 0..N-1 with N up to 65536 -> need
  // 17 bits to hold the value N itself for the "== N-1" compares at NMAX.
  localparam integer IW = NFFT_MAX + 1;   // 17

  always @(posedge aclk) begin
    if (arst) begin
      nfft_q  <= 5'd0;
      shift_q <= 6'd0;
      N_q     <= 17'd0;
    end else if (frame_start) begin
      nfft_q  <= nfft_sel;
      shift_q <= shift_sel;
      N_q     <= (17'd1 << nfft_sel);
    end
  end

  wire [15:0] config_fwd = {7'b0, 1'b1, 3'b0, nfft_sel};  // (1<<8)|nfft_sel
  wire [15:0] config_inv = {7'b0, 1'b0, 3'b0, nfft_sel};  // (0<<8)|nfft_sel

  // =====================================================================
  // FWD config drive: on frame_start present config_fwd until xfft accepts.
  // =====================================================================
  reg         fwd_cfg_tvalid;
  reg  [15:0] fwd_cfg_tdata;
  wire        fwd_cfg_tready;
  always @(posedge aclk) begin
    if (arst) begin
      fwd_cfg_tvalid <= 1'b0;
      fwd_cfg_tdata  <= 16'h0;
    end else if (frame_start) begin
      fwd_cfg_tvalid <= 1'b1;
      fwd_cfg_tdata  <= config_fwd;            // config_fwd of the NEW nfft_sel
    end else if (fwd_cfg_tvalid && fwd_cfg_tready) begin
      fwd_cfg_tvalid <= 1'b0;
    end
  end

  // =====================================================================
  // coefficient BRAM (chirp_fft Q1.15 codes, {im16,re16}), sized for NMAX.
  // Write port = host/TB load; read port = datapath.
  // =====================================================================
  (* ram_style = "block" *) reg [31:0] coef_ram [0:NMAX-1];
  integer ri;
  initial begin
    for (ri = 0; ri < NMAX; ri = ri + 1) coef_ram[ri] = 32'h0;
  end
  always @(posedge aclk) begin
    if (coef_we) coef_ram[coef_waddr] <= coef_wdata;
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
    .s_axis_config_tdata         (fwd_cfg_tdata),
    .s_axis_config_tvalid        (fwd_cfg_tvalid),
    .s_axis_config_tready        (fwd_cfg_tready),
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

  assign dbg_be_fwd          = fwd_m_tuser;
  assign dbg_fwd_cfg_tvalid  = fwd_cfg_tvalid;
  assign dbg_fwd_cfg_tready  = fwd_cfg_tready;
  assign dbg_fwd_m_tvalid    = fwd_m_tvalid;
  assign dbg_fwd_m_tlast     = fwd_m_tlast;

  // ROM addressed by FFT-output beat (natural-order bin), wraps at runtime N.
  reg [IW-1:0] fwd_beat;
  always @(posedge aclk) begin
    if (arst)
      fwd_beat <= {IW{1'b0}};
    else if (fwd_m_tvalid && fwd_m_tready) begin
      if (fwd_m_tlast) fwd_beat <= {IW{1'b0}};
      else             fwd_beat <= fwd_beat + 1'b1;
    end
  end
  wire [31:0] rom_word = coef_ram[fwd_beat[NFFT_MAX-1:0]];

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

  // 33->16 arithmetic right shift + truncate to 16-bit Q1.15 (runtime shift)
  wire signed [39:0] Pq_re_full = P_re >>> shift_q;
  wire signed [39:0] Pq_im_full = P_im >>> shift_q;
  wire [15:0] Pq_re = Pq_re_full[15:0];
  wire [15:0] Pq_im = Pq_im_full[15:0];
  wire [31:0] Pq_word = {Pq_im, Pq_re};

  // =====================================================================
  // Pq buffer RAM (decouples NonBlocking cmpy from xfft_inv backpressure),
  // sized for NMAX.  Counters use the runtime N (N_q).
  // =====================================================================
  reg [31:0] pq_ram [0:NMAX-1];
  integer ii;
  initial begin
    for (ii = 0; ii < NMAX; ii = ii + 1) pq_ram[ii] = 32'h0;
  end

  reg [IW-1:0] prod_beat;     // write address = product beat (natural-order bin)
  reg          pq_full;       // all N products buffered
  always @(posedge aclk) begin
    if (arst) begin
      prod_beat <= {IW{1'b0}};
      pq_full   <= 1'b0;
    end else if (frame_start) begin
      // new frame: clear the buffer state so we re-collect N products
      prod_beat <= {IW{1'b0}};
      pq_full   <= 1'b0;
    end else if (prod_tvalid && !pq_full) begin
      pq_ram[prod_beat[NFFT_MAX-1:0]] <= Pq_word;
      if (prod_beat == N_q - 1'b1) begin
        prod_beat <= {IW{1'b0}};
        pq_full   <= 1'b1;
      end else begin
        prod_beat <= prod_beat + 1'b1;
      end
    end
  end

  // =====================================================================
  // xfft_inv input streamer (reads pq_ram, respects inv tready).
  // =====================================================================
  reg          inv_cfg_done;
  reg          inv_cfg_tvalid;
  reg  [15:0]  inv_cfg_tdata;
  reg  [IW-1:0] inv_rd_addr;
  reg          inv_streaming;
  reg          inv_data_tvalid;
  reg          inv_done;        // this frame's inverse already streamed once

  wire         inv_cfg_tready;
  wire         inv_data_tready;

  // Inverse-FFT config: send config_inv just before streaming the buffered
  // products (i.e. when pq_full rises), NOT at frame_start.  Rationale: at
  // frame_start the PREVIOUS frame's inverse FFT may still be emitting its
  // output; sending a new NFFT config while the IP is mid-frame leaves the
  // inverse transform using the prior frame's scaling/length (observed as a
  // be_inv that is one frame stale).  By pq_full the inverse FFT has long
  // finished the previous frame (the new products only finish buffering ~2N
  // cycles after this frame's data started), so the config lands on a clean
  // frame boundary and applies to the data we are about to stream.
  //   config_inv uses the latched nfft_q (stable for the whole frame).
  reg pq_full_d;
  always @(posedge aclk) pq_full_d <= (arst | frame_start) ? 1'b0 : pq_full;
  wire pq_full_rise = pq_full & ~pq_full_d;

  wire [15:0] config_inv_q = {7'b0, 1'b0, 3'b0, nfft_q};  // (0<<8)|nfft_q

  always @(posedge aclk) begin
    if (arst) begin
      inv_cfg_tvalid <= 1'b0;
      inv_cfg_tdata  <= 16'h0;
      inv_cfg_done   <= 1'b0;
    end else if (frame_start) begin
      // new frame: arm for a fresh config send (done on pq_full_rise)
      inv_cfg_tvalid <= 1'b0;
      inv_cfg_done   <= 1'b0;
    end else if (pq_full_rise) begin
      inv_cfg_tvalid <= 1'b1;
      inv_cfg_tdata  <= config_inv_q;
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
      inv_rd_addr     <= {IW{1'b0}};
      inv_streaming   <= 1'b0;
      inv_data_tvalid <= 1'b0;
      inv_done        <= 1'b0;
    end else if (frame_start) begin
      inv_rd_addr     <= {IW{1'b0}};
      inv_streaming   <= 1'b0;
      inv_data_tvalid <= 1'b0;
      inv_done        <= 1'b0;     // re-arm for the new frame
    end else begin
      if (!inv_streaming) begin
        // start streaming the buffered products EXACTLY ONCE per frame:
        // gate on !inv_done so we don't re-stream the same buffer in a loop
        // (pq_full stays high after the first pass).
        if (pq_full && inv_cfg_done && !inv_done) begin
          inv_streaming   <= 1'b1;
          inv_data_tvalid <= 1'b1;
          inv_rd_addr     <= {IW{1'b0}};
        end
      end else begin
        if (inv_beat_fire) begin
          if (inv_rd_addr == N_q - 1'b1) begin
            inv_streaming   <= 1'b0;
            inv_data_tvalid <= 1'b0;
            inv_done        <= 1'b1;   // done for this frame; wait for next frame_start
          end else begin
            inv_rd_addr <= inv_rd_addr + 1'b1;
          end
        end
      end
    end
  end

  assign dbg_inv_cfg_done   = inv_cfg_done;
  assign dbg_pq_full        = pq_full;
  assign dbg_inv_cfg_tvalid = inv_cfg_tvalid;
  assign dbg_inv_cfg_tready = inv_cfg_tready;
  assign dbg_inv_cfg_tdata  = inv_cfg_tdata;
  assign dbg_inv_data_fire  = inv_beat_fire;
  assign dbg_inv_data_tlast = inv_data_tlast;

  wire [31:0] inv_data_tdata = pq_ram[inv_rd_addr[NFFT_MAX-1:0]];
  wire        inv_data_tlast = inv_streaming && (inv_rd_addr == N_q - 1'b1);

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
