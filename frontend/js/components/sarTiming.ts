/**
 * sarTiming.ts
 *
 * Pure SAR pulse-timing + chirp-colour logic, ported from sar-visualizer
 * (physics/timing.ts + physics/chirp.ts). No three.js / React dependency, so
 * both the 2D timing diagram and the 3D pulse animation share it.
 *
 * Coordinate/units: SI (seconds, metres). C = speed of light.
 */

const C = 299_792_458;

// ---- chirp colour ramp (physics/chirp.ts) ---------------------------------
type RGB = [number, number, number];
const CHIRP_STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0.0, [42, 109, 244]],  // blue  (low f)
  [0.5, [182, 229, 51]],  // yellow-green (mid f)
  [1.0, [255, 59, 59]],   // red   (high f)
];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function chirpRampColor(t: number): RGB {
  const tt = Math.max(0, Math.min(1, t));
  for (let i = 0; i < CHIRP_STOPS.length - 1; i++) {
    const [t0, c0] = CHIRP_STOPS[i];
    const [t1, c1] = CHIRP_STOPS[i + 1];
    if (tt >= t0 && tt <= t1) {
      const k = (tt - t0) / (t1 - t0);
      return [lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)];
    }
  }
  return CHIRP_STOPS[CHIRP_STOPS.length - 1][1];
}

/** CSS rgb() for sub-band k of N (k=0 blue/low .. N-1 red/high). */
export function bandFillCss(k: number, N: number): string {
  const c = chirpRampColor(N < 2 ? 0.5 : k / (N - 1));
  return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
}

// ---- pulse scheduling (physics/timing.ts) ---------------------------------
export interface SubBand {
  txStart: number;
  pw: number;
  nearArrive: number;
  farArrive: number;
}
export interface PulseEvent {
  id: number;
  txStart: number;
  pw: number;
  nearArrive: number;
  farArrive: number;
  rNear: number;
  rFar: number;
  subBands: SubBand[];
}

export interface TimingInput {
  altitudeM: number;
  lookRad: number;
  beamRgRad: number;
  prfHz: number;
  pulseWidthS: number;
  nSub: number;                       // sub-band count
  chirpDir: 'up' | 'down' | 'updown';
}

function swathSlant(altM: number, lookRad: number, beamRgRad: number) {
  const thNear = lookRad - beamRgRad / 2;
  const thFar = lookRad + beamRgRad / 2;
  const gNear = altM * Math.tan(thNear);
  const gFar = altM * Math.tan(thFar);
  const rNear = Math.sqrt(altM * altM + gNear * gNear);
  const rFar = Math.sqrt(altM * altM + gFar * gFar);
  return { rNear, rFar };
}

function makeSubBands(parent: Omit<PulseEvent, 'subBands'>, N: number,
                      dir: 'up' | 'down', altM: number, lookRad: number,
                      beamRgRad: number): SubBand[] {
  const subDur = parent.pw / N; // Standard antenna: gammaW=0
  const out: SubBand[] = [];
  for (let k = 0; k < N; k++) {
    const idx = dir === 'down' ? N - 1 - k : k;
    const sK = (idx + 0.5) * subDur;
    const txStartK = parent.txStart + sK - subDur / 2;
    // Standard antenna: frequency-flat, full range beam -> same swath for all k.
    const { rNear, rFar } = swathSlant(altM, lookRad, beamRgRad);
    out.push({
      txStart: txStartK,
      pw: subDur,
      nearArrive: txStartK + (2 * rNear) / C,
      farArrive: txStartK + (2 * rFar) / C,
    });
  }
  return out;
}

/** Schedule pulses (with sub-bands) within [windowStart, windowEnd] seconds. */
export function schedulePulses(inp: TimingInput, windowStart: number, windowEnd: number): PulseEvent[] {
  const pri = 1 / inp.prfHz;
  const pw = inp.pulseWidthS;
  const { rNear, rFar } = swathSlant(inp.altitudeM, inp.lookRad, inp.beamRgRad);
  const farRoundTrip = (2 * rFar) / C;
  const fullLife = farRoundTrip + pw;
  const N = Math.max(1, Math.floor(inp.nSub));

  const k0 = Math.max(0, Math.floor((windowStart - fullLife) / pri));
  const k1 = Math.max(0, Math.ceil(windowEnd / pri));

  const pulses: PulseEvent[] = [];
  for (let k = k0; k <= k1; k++) {
    const txStart = k * pri;
    if (txStart < 0) continue;
    const farArrive = txStart + farRoundTrip;
    if (farArrive + pw < windowStart) continue;
    if (txStart > windowEnd) continue;
    const dir: 'up' | 'down' = inp.chirpDir === 'updown'
      ? (k % 2 === 0 ? 'up' : 'down')
      : inp.chirpDir;
    const parent = {
      id: k, txStart, pw,
      nearArrive: txStart + (2 * rNear) / C,
      farArrive,
      rNear, rFar,
    };
    pulses.push({ ...parent, subBands: makeSubBands(parent, N, dir, inp.altitudeM, inp.lookRad, inp.beamRgRad) });
  }
  return pulses;
}

/** TX/RX overlap (blind range) at time t. */
export function isOverlapAt(t: number, pulses: ReadonlyArray<PulseEvent>) {
  const txActive = pulses.some((p) => p.txStart <= t && t < p.txStart + p.pw);
  const rxActive = pulses.some((p) => p.nearArrive <= t && t < p.farArrive + p.pw);
  return { txActive, rxActive, overlap: txActive && rxActive };
}

export { C as SPEED_OF_LIGHT };
