# Timing constraint for echo_datapath synthesis/timing study.
# Target 250 MHz (4.0 ns) — the xfft_0 IP target clock; SAR avg data rate
# (PRF*Nr ~107 MSPS) is well under this, so 250 MHz gives real-time headroom.
create_clock -period 4.000 -name aclk [get_ports aclk]
