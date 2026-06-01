// =====================================================================
// ON-HARDWARE SELF-TEST for the runtime-N SAR echo-synthesis datapath.
//
// Runs echo_datapath_rt on the REAL ZCU111 (xczu28dr) and lets a host
// (via VIO + ILA over JTAG) prove the silicon output is bit-identical to
// the Python hardware-faithful model (model_echo_datapath).
//
// Stimulus is baked into the bitstream as two ROMs initialised from the
// N=1024 reference vectors:
//   * echo_fir_1024.mem  : 1024 input words  {im16,re16} Q1.15
//   * echo_coef_1024.mem  : 1024 coeff words (chirp_fft Q1.15, be_coef=7)
// Reference output (the truth) = tmp/echo_s_expected_1024.txt.
//
// Config under test: nfft_sel=10 (N=1024), shift_sel=14, be_inv expected=4.
//
// Flow on hardware:
//   1. clk_wiz_0 turns the ZCU111 user SI570 300 MHz diff board clock
//      (free-running at its factory NVM default; no I2C needed) into
//      ~250 MHz aclk.  Rate is not critical -- this is a functional test.
//   2. After reset, an FSM auto-loads the datapath coeff BRAM from the
//      coeff ROM (k=0..N-1 via coef_we/coef_waddr/coef_wdata).
//   3. On a VIO `vio_start` rising edge the FSM pulses frame_start (1 cyc)
//      then streams the 1024 fir words into the datapath AXIS input,
//      respecting s_axis_data_tready and asserting tlast at word 1023.
//      nfft_sel/shift_sel come from VIO (host sets 10 / 14).
//   4. The datapath s_raw AXIS output (tdata {im,re}, tvalid, tlast,
//      tuser=be_inv) is captured by an ILA the host arms beforehand.
//
// The host then exports the ILA CSV, extracts the 1024 output beats and
// compares re/im codes + be_inv against the model, expecting 100% match.
// =====================================================================
`timescale 1ns / 1ps

module echo_selftest #(
    parameter integer N        = 1024,    // frame length for this test
    parameter integer NFFT_MAX = 16,
    parameter integer NMAX     = (1 << NFFT_MAX)
) (
    input  wire        aclk,
    input  wire        aresetn,      // active-low (from clk_wiz locked)

    // ---- VIO control (host) ----
    input  wire        vio_start,    // level from VIO; rising edge launches a frame
    input  wire [4:0]  vio_nfft_sel, // = 10 for N=1024
    input  wire [5:0]  vio_shift_sel,// = 14
    output wire        vio_done,     // high after a frame's s_raw fully streamed

    // ---- s_raw output exposed for ILA capture ----
    output wire [31:0] o_sraw_tdata, // {im16, re16} Q1.15
    output wire [7:0]  o_sraw_be,    // be_inv block exponent (tuser)
    output wire        o_sraw_tvalid,
    output wire        o_sraw_tlast,

    // ---- extra ILA visibility ----
    output wire        o_frame_start,
    output wire        o_loading,
    output wire        o_streaming
);

  localparam integer AW = NFFT_MAX;  // coeff/fir ROM address width (16)

  // ---------------------------------------------------------------
  // synchronous reset from active-low aresetn
  // ---------------------------------------------------------------
  reg arst;
  always @(posedge aclk) arst <= ~aresetn;

  // ---------------------------------------------------------------
  // Input ROMs (initialised from the reference vectors).
  // ---------------------------------------------------------------
  (* rom_style = "block" *) reg [31:0] fir_rom  [0:NMAX-1];
  (* rom_style = "block" *) reg [31:0] coef_rom [0:NMAX-1];
  integer gi;
  initial begin
    for (gi = 0; gi < NMAX; gi = gi + 1) begin
      fir_rom[gi]  = 32'h0;
      coef_rom[gi] = 32'h0;
    end
    $readmemh("echo_fir_1024.mem",  fir_rom);
    $readmemh("echo_coef_1024.mem", coef_rom);
  end

  // ---------------------------------------------------------------
  // VIO start rising-edge detect -> launch
  // ---------------------------------------------------------------
  reg vio_start_d;
  always @(posedge aclk) vio_start_d <= arst ? 1'b0 : vio_start;
  wire vio_start_rise = vio_start & ~vio_start_d;

  // ---------------------------------------------------------------
  // Control FSM
  //   IDLE_RST -> LOAD (write coeff BRAM 0..N-1) -> READY
  //   READY: wait vio_start_rise -> FRAME_START (1 cyc) -> STREAM fir
  //   STREAM: feed fir words while datapath tready; tlast at N-1
  //   DONE: vio_done high; new start re-arms back through FRAME_START
  // ---------------------------------------------------------------
  localparam [2:0] S_RST=3'd0, S_LOAD=3'd1, S_READY=3'd2,
                   S_FSTART=3'd3, S_STREAM=3'd4, S_DRAIN=3'd5, S_DONE=3'd6;
  reg [2:0]      state;
  reg [AW:0]     idx;          // load / stream index (0..N), needs N value
  reg [4:0]      nfft_q;
  reg [5:0]      shift_q;

  // coeff write port
  reg            coef_we;
  reg [NFFT_MAX-1:0] coef_waddr;
  reg [31:0]     coef_wdata;

  // fir AXIS drive
  reg            fir_tvalid;
  reg [31:0]     fir_tdata;
  reg            fir_tlast;
  wire           fir_tready;     // from datapath

  // one-cycle frame_start
  reg            frame_start;
  reg            done_q;

  wire [31:0] fir_rom_word  = fir_rom[idx[AW-1:0]];
  wire [31:0] coef_rom_word = coef_rom[idx[AW-1:0]];

  always @(posedge aclk) begin
    if (arst) begin
      state       <= S_RST;
      idx         <= {(AW+1){1'b0}};
      coef_we     <= 1'b0;
      coef_waddr  <= {NFFT_MAX{1'b0}};
      coef_wdata  <= 32'h0;
      fir_tvalid  <= 1'b0;
      fir_tdata   <= 32'h0;
      fir_tlast   <= 1'b0;
      frame_start <= 1'b0;
      done_q      <= 1'b0;
      nfft_q      <= 5'd0;
      shift_q     <= 6'd0;
    end else begin
      frame_start <= 1'b0;   // default: pulse only
      coef_we     <= 1'b0;   // default

      case (state)
        // -------- load coeff BRAM from coeff ROM --------
        S_RST: begin
          idx   <= {(AW+1){1'b0}};
          state <= S_LOAD;
        end
        S_LOAD: begin
          coef_we    <= 1'b1;
          coef_waddr <= idx[NFFT_MAX-1:0];
          coef_wdata <= coef_rom_word;
          if (idx == N-1) begin
            idx   <= {(AW+1){1'b0}};
            state <= S_READY;
          end else begin
            idx <= idx + 1'b1;
          end
        end

        // -------- wait for host start --------
        S_READY: begin
          done_q <= 1'b0;
          if (vio_start_rise) begin
            nfft_q      <= vio_nfft_sel;
            shift_q     <= vio_shift_sel;
            frame_start <= 1'b1;     // 1-cycle pulse to datapath
            idx         <= {(AW+1){1'b0}};
            state       <= S_FSTART;
          end
        end

        // -------- frame_start consumed; begin presenting fir --------
        S_FSTART: begin
          fir_tvalid <= 1'b1;
          fir_tdata  <= fir_rom_word;       // idx==0 word
          fir_tlast  <= (N == 1) ? 1'b1 : 1'b0;
          state      <= S_STREAM;
        end

        // -------- stream fir words, respect tready --------
        S_STREAM: begin
          fir_tvalid <= 1'b1;
          if (fir_tvalid && fir_tready) begin
            if (idx == N-1) begin
              // last word just accepted
              fir_tvalid <= 1'b0;
              fir_tlast  <= 1'b0;
              state      <= S_DRAIN;
            end else begin
              idx       <= idx + 1'b1;
              fir_tdata <= fir_rom[ (idx[AW-1:0] + 1'b1) ];  // next word
              fir_tlast <= (idx == N-2) ? 1'b1 : 1'b0;
            end
          end else begin
            // hold current word/tlast until accepted
            fir_tdata <= fir_rom_word;
            fir_tlast <= (idx == N-1) ? 1'b1 : 1'b0;
          end
        end

        // -------- wait for s_raw output frame to finish --------
        S_DRAIN: begin
          if (o_sraw_tvalid && o_sraw_tlast) begin
            state  <= S_DONE;
            done_q <= 1'b1;
          end
        end

        S_DONE: begin
          done_q <= 1'b1;
          if (vio_start_rise) begin
            nfft_q      <= vio_nfft_sel;
            shift_q     <= vio_shift_sel;
            frame_start <= 1'b1;
            idx         <= {(AW+1){1'b0}};
            done_q      <= 1'b0;
            state       <= S_FSTART;
          end
        end

        default: state <= S_RST;
      endcase
    end
  end

  assign vio_done      = done_q;
  assign o_frame_start = frame_start;
  assign o_loading     = (state == S_LOAD);
  assign o_streaming   = (state == S_STREAM) || (state == S_FSTART);

  // ---------------------------------------------------------------
  // Datapath under test
  // ---------------------------------------------------------------
  wire [31:0] dut_m_tdata;
  wire [7:0]  dut_m_tuser;
  wire        dut_m_tvalid;
  wire        dut_m_tlast;
  wire        dut_m_tready = 1'b1;   // always consume s_raw (ILA observes)

  // unused datapath debug outputs
  wire [7:0]  u_be_fwd;
  wire        u_fwd_cfg_tvalid, u_fwd_cfg_tready, u_inv_cfg_done;
  wire        u_pq_full, u_fwd_m_tvalid, u_fwd_m_tlast;
  wire        u_inv_cfg_tvalid, u_inv_cfg_tready;
  wire [15:0] u_inv_cfg_tdata;
  wire        u_inv_data_fire, u_inv_data_tlast;

  echo_datapath_rt #(
      .NFFT_MAX (NFFT_MAX)
  ) u_dut (
      .aclk               (aclk),
      .arst               (arst),
      .nfft_sel           (nfft_q),
      .shift_sel          (shift_q),
      .coef_we            (coef_we),
      .coef_waddr         (coef_waddr),
      .coef_wdata         (coef_wdata),
      .s_axis_data_tvalid (fir_tvalid),
      .s_axis_data_tdata  (fir_tdata),
      .s_axis_data_tlast  (fir_tlast),
      .s_axis_data_tready (fir_tready),
      .frame_start        (frame_start),
      .m_axis_data_tdata  (dut_m_tdata),
      .m_axis_data_tuser  (dut_m_tuser),
      .m_axis_data_tvalid (dut_m_tvalid),
      .m_axis_data_tlast  (dut_m_tlast),
      .m_axis_data_tready (dut_m_tready),
      .dbg_be_fwd         (u_be_fwd),
      .dbg_fwd_cfg_tvalid (u_fwd_cfg_tvalid),
      .dbg_fwd_cfg_tready (u_fwd_cfg_tready),
      .dbg_inv_cfg_done   (u_inv_cfg_done),
      .dbg_pq_full        (u_pq_full),
      .dbg_fwd_m_tvalid   (u_fwd_m_tvalid),
      .dbg_fwd_m_tlast    (u_fwd_m_tlast),
      .dbg_inv_cfg_tvalid (u_inv_cfg_tvalid),
      .dbg_inv_cfg_tready (u_inv_cfg_tready),
      .dbg_inv_cfg_tdata  (u_inv_cfg_tdata),
      .dbg_inv_data_fire  (u_inv_data_fire),
      .dbg_inv_data_tlast (u_inv_data_tlast)
  );

  assign o_sraw_tdata  = dut_m_tdata;
  assign o_sraw_be     = dut_m_tuser;
  assign o_sraw_tvalid = dut_m_tvalid;
  assign o_sraw_tlast  = dut_m_tlast;

endmodule


// =====================================================================
// Top wrapper: ZCU111 SI570 diff board clock -> clk_wiz -> aclk, plus
// the VIO/ILA debug cores (instantiated post-synth via create_debug_core,
// so the top only needs the clk_wiz + VIO here).
// =====================================================================
module echo_selftest_top (
    input  wire user_si570_sysclk_p,
    input  wire user_si570_sysclk_n
);

  wire aclk;
  wire locked;

  // Clocking Wizard: 300 MHz diff in -> ~250 MHz aclk
  clk_wiz_0 u_clk (
      .clk_in1_p (user_si570_sysclk_p),
      .clk_in1_n (user_si570_sysclk_n),
      .clk_out1  (aclk),
      .locked    (locked)
  );

  // Reset: hold low until clk_wiz locks
  wire aresetn = locked;

  // --- VIO control nets ---
  wire        vio_start;
  wire [4:0]  vio_nfft_sel;
  wire [5:0]  vio_shift_sel;
  wire        vio_done;

  // --- self-test core ---
  wire [31:0] sraw_tdata;
  wire [7:0]  sraw_be;
  wire        sraw_tvalid;
  wire        sraw_tlast;
  wire        frame_start_dbg;
  wire        loading_dbg;
  wire        streaming_dbg;

  echo_selftest #(
      .N (1024)
  ) u_selftest (
      .aclk          (aclk),
      .aresetn       (aresetn),
      .vio_start     (vio_start),
      .vio_nfft_sel  (vio_nfft_sel),
      .vio_shift_sel (vio_shift_sel),
      .vio_done      (vio_done),
      .o_sraw_tdata  (sraw_tdata),
      .o_sraw_be     (sraw_be),
      .o_sraw_tvalid (sraw_tvalid),
      .o_sraw_tlast  (sraw_tlast),
      .o_frame_start (frame_start_dbg),
      .o_loading     (loading_dbg),
      .o_streaming   (streaming_dbg)
  );

  // VIO core (control). Probe widths:
  //  in0  : vio_done            (1)
  //  out0 : vio_start           (1)
  //  out1 : vio_nfft_sel        (5)
  //  out2 : vio_shift_sel       (6)
  vio_0 u_vio (
      .clk        (aclk),
      .probe_in0  (vio_done),
      .probe_out0 (vio_start),
      .probe_out1 (vio_nfft_sel),
      .probe_out2 (vio_shift_sel)
  );

  // ILA is inserted post-synth via create_debug_core on these marked nets.
  // keep+mark_debug so synth preserves them as distinct, probe-able nets.
  (* mark_debug = "true", keep = "true" *) wire [31:0] dbg_sraw_tdata  = sraw_tdata;
  (* mark_debug = "true", keep = "true" *) wire [7:0]  dbg_sraw_be     = sraw_be;
  (* mark_debug = "true", keep = "true" *) wire        dbg_sraw_tvalid = sraw_tvalid;
  (* mark_debug = "true", keep = "true" *) wire        dbg_sraw_tlast  = sraw_tlast;
  (* mark_debug = "true", keep = "true" *) wire        dbg_frame_start = frame_start_dbg;

endmodule
