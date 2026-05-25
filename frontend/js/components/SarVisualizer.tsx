/**
 * SarVisualizer.tsx
 *
 * GUI-widget body for the `sar_visualizer` block. Embeds a reduced version of
 * the standalone sar-visualizer (D:\Claude\sar-visualizer) inside a flow node:
 *
 *   +-------------------- SAR Visualizer node --------------------+
 *   |  PARAMETERS (sliders)  |   3D satellite / ground / beam      |
 *   |  Altitude  [=====o==]  |        (orbit-controls)             |
 *   |  Look      [===o====]  |                                     |
 *   |  Beam Az   [=o======]  |                                     |
 *   |  ...                   +-------------------------------------+
 *   |  Mode  strip|slid|spot |   TX/RX timing diagram (canvas 2D)  |
 *   +------------------------------------------------------------+
 *
 * Sliders write to the node's parameters via onParamChange AND drive the live
 * 3D scene immediately (no flow run needed). On flow run, code_utils.make_sar_
 * params_code turns the same values into kernel variables (H, look, ...).
 *
 * React Flow coexistence: host carries "nodrag nopan nowheel" and every
 * interactive control stops propagation, mirroring Surface3D / GuiSlider so the
 * canvas does not pan/zoom while the user drags inside the node.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createSarScene, SarSceneHandle, SarParams, computeDerived } from './SarSceneManager.js';
import { schedulePulses, bandFillCss, TimingInput } from './sarTiming.js';

// Parameter definition shape (subset of the block JSON parameter entries).
export interface SarParamDef {
  id: string;
  label?: string;
  dtype?: string;
  default?: string;
  min?: string;
  max?: string;
  step?: string;
  unit?: string;
  var?: string;
  scale?: string;
  options?: string[];
  hidden?: boolean;
}

interface SarVisualizerProps {
  params: Record<string, string>;
  paramDefs: SarParamDef[];
  onParamChange: (id: string, val: string) => void;
}

const DEG = Math.PI / 180;

/** Build the SI-unit SarParams the 3D scene needs from the raw slider values. */
function toSarParams(params: Record<string, string>, defs: SarParamDef[]): SarParams {
  const get = (id: string): number => {
    const def = defs.find((d) => d.id === id);
    const raw = params[id] ?? def?.default ?? '0';
    const n = parseFloat(raw);
    return isNaN(n) ? parseFloat(def?.default ?? '0') || 0 : n;
  };
  const getStr = (id: string): string => {
    const def = defs.find((d) => d.id === id);
    return params[id] ?? def?.default ?? '';
  };
  return {
    altitudeM: get('altitude_km') * 1000,
    lookRad: get('look_deg') * DEG,
    beamAzRad: get('beam_az_deg') * DEG,
    beamRgRad: get('beam_rg_deg') * DEG,
    satAzimuthM: 0, // Phase A: satellite at nadir-origin. Phase B adds azimuth playback.
    obsMode: getStr('obs_mode'),
  };
}

function fmt(n: number, digits = 1): string {
  if (!isFinite(n)) return '–';
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  return n.toFixed(digits);
}

// ---- one slider row --------------------------------------------------------
function SarSliderRow({ def, value, onChange }: {
  def: SarParamDef;
  value: string;
  onChange: (id: string, val: string) => void;
}) {
  const min = parseFloat(def.min ?? '0');
  const max = parseFloat(def.max ?? '100');
  const step = parseFloat(def.step ?? '1');
  const num = value === '' || value == null ? parseFloat(def.default ?? '0') : parseFloat(value);
  return (
    <div className="sarviz-row">
      <div className="sarviz-row-head">
        <span className="sarviz-row-label">{def.label ?? def.id}</span>
        <span className="sarviz-row-value">{fmt(num, step < 1 ? 2 : 0)}{def.unit ? ` ${def.unit}` : ''}</span>
      </div>
      <input
        type="range"
        className="sarviz-slider nodrag nopan"
        min={min} max={max} step={step}
        value={isNaN(num) ? min : num}
        onChange={(e) => onChange(def.id, e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ---- enum row (segmented buttons) -----------------------------------------
function SarEnumRow({ def, value, onChange }: {
  def: SarParamDef;
  value: string;
  onChange: (id: string, val: string) => void;
}) {
  const options = def.options ?? [];
  const cur = value || def.default || options[0] || '';
  return (
    <div className="sarviz-row">
      <div className="sarviz-row-head">
        <span className="sarviz-row-label">{def.label ?? def.id}</span>
      </div>
      <div className="sarviz-segmented nodrag nopan">
        {options.map((opt) => (
          <button
            key={opt}
            className={`sarviz-seg-btn${cur === opt ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onChange(def.id, opt); }}
          >{opt}</button>
        ))}
      </div>
    </div>
  );
}

// ---- shared sim clock ------------------------------------------------------
// A tiny mutable clock advanced by the timing diagram's rAF loop and read by
// both the diagram and the 3D pulse animation. slowMo factor 10^slowMoExp maps
// wall-clock dt to sim seconds (default 1e-3 = 1/1000x, matches sar-visualizer).
export interface SimClock { t: number; running: boolean; slowMoExp: number; }

// ---- timing diagram (canvas 2D, faithful port of TimingDiagram.tsx) --------
const NOW_FRACTION = 0.75;
const MIN_BAND_PX = 2;
// Zoom levels = how many pulse-repetition intervals are visible. The time axis
// scales with PRF (so pulses stay legible at any PRF) and the −/+ buttons step
// through these (smaller = zoomed in). Mirrors sar-visualizer's zoom control.
const ZOOM_PRIS = [2, 4, 8, 16, 32] as const;
const DEFAULT_ZOOM_INDEX = 1; // 4 PRIs

function TimingDiagram({ timing, clock, windowPris }: { timing: TimingInput; clock: React.MutableRefObject<SimClock>; windowPris: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const timingRef = useRef(timing);
  const windowPrisRef = useRef(windowPris);
  windowPrisRef.current = windowPris;
  timingRef.current = timing;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();

    const draw = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      const ck = clock.current;
      const factor = Math.pow(10, ck.slowMoExp);
      if (ck.running) ck.t += dt * factor;
      const t = ck.t;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = cv.clientWidth, h = cv.clientHeight;
      cv.width = Math.max(w * dpr, 1); cv.height = Math.max(h * dpr, 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0d1424'; ctx.fillRect(0, 0, w, h);

      // Visible window scales with PRF so a few PRIs are always shown (the time
      // axis zooms automatically; pulses stay wide enough to see the chirp slant).
      // windowPris is the −/+ zoom level (PRIs visible).
      const pri = 1 / Math.max(1, timingRef.current.prfHz);
      const WINDOW_S = pri * windowPrisRef.current;
      const EVENT_WINDOW_S = WINDOW_S * 1.5;

      const t0 = t - WINDOW_S * NOW_FRACTION;
      const tEnd = t0 + WINDOW_S;
      const labelW = 24;
      const xOf = (s: number) => labelW + ((s - t0) / WINDOW_S) * (w - labelW);

      // grid: a faint line at each PRI boundary (one per transmitted pulse),
      // plus ms tick labels at a step chosen so labels never crowd.
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(58,77,118,0.35)';
      for (let s = Math.ceil(t0 / pri) * pri; s <= tEnd; s += pri) {
        const x = xOf(s);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      // ms labels: pick a step (0.1/0.2/0.5/1/2/5 ms) giving ~5 labels.
      const targetLabels = 5;
      const rawStepMs = (WINDOW_S * 1000) / targetLabels;
      const niceSteps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
      const stepMs = niceSteps.find((s) => s >= rawStepMs) ?? 10;
      ctx.strokeStyle = '#3a4d76';
      ctx.fillStyle = '#5a6783';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'start';
      const firstMs = Math.ceil((t0 * 1000) / stepMs) * stepMs;
      for (let ms = firstMs; ms <= tEnd * 1000 + 1e-9; ms += stepMs) {
        const x = xOf(ms / 1000);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        const label = stepMs < 1 ? `${ms.toFixed(1)}` : `${Math.round(ms)}`;
        ctx.fillText(`${label}ms`, x + 2, h - 2);
      }

      // tracks: TX (top) and RX (bottom), packed tightly. The fixed margins
      // (label space, axis-label space, inter-track gap) scale DOWN when the
      // pane is short so the whole diagram always fits — dragging the splitter
      // smaller shrinks everything rather than clipping the RX track.
      const fit = Math.min(1, h / 96);            // 1 at >=96px, smaller below
      const trackTopY = 10 * fit;                 // room for the TX label
      const bottomPad = 12 * fit;                 // room for the ms axis labels
      const gap = 6 * fit;                        // small space between TX and RX bars
      const slotH = Math.max(1, (h - trackTopY - bottomPad - gap) / 2);
      const trackInnerH = slotH;                 // bars fill the slot, TX == RX
      const txTop = trackTopY;
      const rxTop = trackTopY + slotH + gap;
      const N = Math.max(1, Math.floor(timingRef.current.nSub));
      const visualRow = (k: number) => N - 1 - k;
      const rowYTop = (top: number, k: number) => top + (visualRow(k) * trackInnerH) / N;
      const rowH = trackInnerH / N;

      ctx.fillStyle = '#5dd5ff'; ctx.fillText('TX', 2, txTop + 8);
      ctx.fillStyle = '#ff8c42'; ctx.fillText('RX', 2, rxTop + 8);

      const pulses = schedulePulses(timingRef.current, t - EVENT_WINDOW_S, t + EVENT_WINDOW_S);

      // Per-sub-band rectangles, exactly as sar-visualizer's TimingDiagram.tsx:
      // each pulse is N sub-bands; sub-band k owns a frequency row (k=0 blue/low
      // at the bottom, k=N-1 red/high at the top). TX rect = [txStart_k,
      // txStart_k+pw_k] (pw_k = pw/N, narrow — the chirp marches in time across
      // rows, giving a thin slanted line). RX rect = [nearArrive_k,
      // farArrive_k+pw_k] (widened by the swath bracket — a parallelogram). The
      // colour index k feeds bandFillCss unchanged (direction is already in
      // txStart). N=64 makes the colour read as a smooth gradient.
      const rowYTop2 = (top: number, k: number) => top + ((N - 1 - k) * trackInnerH) / N;
      const rowYBot2 = (top: number, k: number) => top + ((N - 1 - k + 1) * trackInnerH) / N;
      const drawBandRect = (tStart: number, tEnd: number, yTop: number, yBot: number, fill: string) => {
        const x0 = Math.max(labelW, xOf(tStart));
        const x1 = Math.min(w, xOf(tEnd));
        if (x1 <= x0) return;
        ctx.fillStyle = fill;
        ctx.fillRect(x0, yTop, Math.max(MIN_BAND_PX, x1 - x0), Math.max(MIN_BAND_PX, yBot - yTop));
      };
      for (const p of pulses) {
        for (let k = 0; k < p.subBands.length; k++) {
          const sb = p.subBands[k];
          const fill = bandFillCss(k, N);
          drawBandRect(sb.txStart, sb.txStart + sb.pw, rowYTop2(txTop, k), rowYBot2(txTop, k), fill);
          drawBandRect(sb.nearArrive, sb.farArrive + sb.pw, rowYTop2(rxTop, k), rowYBot2(rxTop, k), fill);
        }
      }

      // overlap (blind range): pink blink where TX and RX coincide
      const blink = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin((now / 400) * 2 * Math.PI));
      ctx.fillStyle = `rgba(255,47,107,${blink.toFixed(3)})`;
      for (const pTx of pulses) for (const sbTx of pTx.subBands) {
        for (const pRx of pulses) for (const sbRx of pRx.subBands) {
          const o0 = Math.max(sbTx.txStart, sbRx.nearArrive);
          const o1 = Math.min(sbTx.txStart + sbTx.pw, sbRx.farArrive + sbRx.pw);
          if (o0 < o1) {
            const x0 = Math.max(labelW, xOf(o0)), x1 = Math.min(w, xOf(o1));
            if (x1 > x0) ctx.fillRect(x0, txTop, x1 - x0, rxTop + trackInnerH - txTop);
          }
        }
      }

      // NOW (ANT) cursor
      const xn = xOf(t);
      ctx.strokeStyle = '#ffc344'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(xn, 8); ctx.lineTo(xn, h); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ffc344';
      ctx.beginPath(); ctx.moveTo(xn - 4, 1); ctx.lineTo(xn + 4, 1); ctx.lineTo(xn, 8); ctx.closePath(); ctx.fill();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  return <canvas ref={ref} className="sarviz-timing-canvas" />;
}

// ---- drag-to-resize splitter ----------------------------------------------
// Generic pointer-drag handler returning an onPointerDown for a splitter bar.
// `axis` 'x' resizes width, 'y' resizes height. `sign` flips the direction so
// dragging the bar feels natural for the pane it borders. The current size is
// read from a ref (not via a setState updater, whose timing is unreliable for
// capturing the start value). Stops propagation so React Flow does not pan.
function useSplitter(
  sizeRef: React.MutableRefObject<number>,
  setSize: (v: number) => void,
  axis: 'x' | 'y',
  sign = 1,
  min = 120,
  max = 1200,
  onCommit?: (v: number) => void,
) {
  return useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startSize = sizeRef.current;
    const onMove = (ev: PointerEvent) => {
      const cur = axis === 'x' ? ev.clientX : ev.clientY;
      const next = Math.max(min, Math.min(max, startSize + (cur - start) * sign));
      sizeRef.current = next;
      setSize(next);
    };
    const onUp = () => {
      onCommit?.(Math.round(sizeRef.current));   // persist final size to the node
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [sizeRef, setSize, axis, sign, min, max, onCommit]);
}

// ---- main widget body ------------------------------------------------------
export default function SarVisualizer({ params, paramDefs, onParamChange }: SarVisualizerProps) {
  const sceneHostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SarSceneHandle | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resizable pane sizes (px). Left controls width, and timing-diagram height.
  // Initialised from the node's saved params so a chosen layout persists across
  // save/reload; refs mirror the state for synchronous reads during a drag.
  const initialControlsW = parseFloat(params.controls_width ?? '') || 230;
  const initialTimingH = parseFloat(params.timing_height ?? '') || 60;
  const [controlsW, setControlsW] = useState(initialControlsW);
  const [timingH, setTimingH] = useState(initialTimingH);
  const controlsWRef = useRef(initialControlsW);
  const timingHRef = useRef(initialTimingH);
  // Persist the final size to the node (written to defaultParameters -> .rcflow).
  const commitControlsW = useCallback((v: number) => onParamChange('controls_width', String(v)), [onParamChange]);
  const commitTimingH = useCallback((v: number) => onParamChange('timing_height', String(v)), [onParamChange]);
  const dragControls = useSplitter(controlsWRef, setControlsW, 'x', 1, 140, 480, commitControlsW);
  const dragTiming = useSplitter(timingHRef, setTimingH, 'y', -1, 40, 400, commitTimingH);

  // Shared sim clock + latest timing params (refs so the once-only mount effect
  // can read current values without re-subscribing).
  const clockRef = useRef<SimClock>({ t: 0, running: true, slowMoExp: -3 });
  const timingRef = useRef<TimingInput>({
    altitudeM: 514e3, lookRad: 25 * DEG, beamRgRad: 2 * DEG,
    prfHz: 4000, pulseWidthS: 10e-6, nSub: 8, chirpDir: 'up',
  });

  // Hidden params (e.g. saved pane sizes) are not rendered as controls.
  const visibleDefs = useMemo(() => paramDefs.filter((d) => !d.hidden), [paramDefs]);
  const sliderDefs = useMemo(() => visibleDefs.filter((d) => d.dtype !== 'enum'), [visibleDefs]);
  const enumDefs = useMemo(() => visibleDefs.filter((d) => d.dtype === 'enum'), [visibleDefs]);

  const sarParams = useMemo(() => toSarParams(params, paramDefs), [params, paramDefs]);
  const derived = useMemo(() => computeDerived(sarParams), [sarParams]);

  // Mount the 3D scene once.
  useEffect(() => {
    let cancelled = false;
    const host = sceneHostRef.current;
    if (!host) return;
    createSarScene(host)
      .then((handle) => {
        if (cancelled) { handle.dispose(); return; }
        sceneRef.current = handle;
        handle.update(toSarParams(params, paramDefs));
        handle.setTiming(timingRef.current, clockRef.current);
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push parameter changes to the live scene.
  useEffect(() => {
    sceneRef.current?.update(sarParams);
  }, [sarParams]);

  const handleChange = useCallback((id: string, val: string) => {
    onParamChange(id, val);
  }, [onParamChange]);

  const prfHz = parseFloat(params.prf_hz ?? paramDefs.find((d) => d.id === 'prf_hz')?.default ?? '4000');
  const pulseUs = parseFloat(params.pulse_width_us ?? paramDefs.find((d) => d.id === 'pulse_width_us')?.default ?? '10');

  const [running, setRunning] = useState(true);
  const [slowMoExp, setSlowMoExp] = useState(-3);
  useEffect(() => { clockRef.current.running = running; }, [running]);
  useEffect(() => { clockRef.current.slowMoExp = slowMoExp; }, [slowMoExp]);

  // Time-axis zoom index (persisted to the node like the pane sizes).
  const initialZoom = (() => {
    const v = parseInt(params.timing_zoom ?? '', 10);
    return Number.isInteger(v) && v >= 0 && v < ZOOM_PRIS.length ? v : DEFAULT_ZOOM_INDEX;
  })();
  const [zoomIdx, setZoomIdxState] = useState(initialZoom);
  const setZoomIdx = useCallback((updater: (i: number) => number) => {
    setZoomIdxState((prev) => {
      const next = updater(prev);
      onParamChange('timing_zoom', String(next));   // persist to .rcflow
      return next;
    });
  }, [onParamChange]);

  // Timing parameters (shared by 2D + 3D). Sub-band count kept modest (8) to
  // stay light inside a node vs the original's 64.
  const timing: TimingInput = useMemo(() => ({
    altitudeM: sarParams.altitudeM,
    lookRad: sarParams.lookRad,
    beamRgRad: sarParams.beamRgRad,
    prfHz,
    pulseWidthS: pulseUs * 1e-6,
    nSub: 64,   // matches sar-visualizer default; smooth chirp gradient
    chirpDir: (params.chirp_dir as 'up' | 'down' | 'updown') ?? 'up',
  }), [sarParams.altitudeM, sarParams.lookRad, sarParams.beamRgRad, prfHz, pulseUs, params.chirp_dir]);

  // Keep the ref current and hand timing + clock to the 3D scene.
  useEffect(() => {
    timingRef.current = timing;
    sceneRef.current?.setTiming(timing, clockRef.current);
  }, [timing]);

  return (
    <div className="sarviz-body nodrag nopan nowheel"
      onWheel={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}>
      {/* Left: parameter controls, full node height (drag-resizable width) */}
      <div className="sarviz-controls" style={{ width: `${controlsW}px` }}>
        <div className="sarviz-section-title">PARAMETERS</div>
        {sliderDefs.map((def) => (
          <SarSliderRow key={def.id} def={def}
            value={params[def.id] ?? def.default ?? ''} onChange={handleChange} />
        ))}
        {enumDefs.map((def) => (
          <SarEnumRow key={def.id} def={def}
            value={params[def.id] ?? def.default ?? ''} onChange={handleChange} />
        ))}
      </div>

      {/* Vertical splitter between controls and the right column */}
      <div className="sarviz-splitter-v nodrag nopan" onPointerDown={dragControls} title="Drag to resize" />

      {/* Right column: 3D scene (top) over timing diagram (bottom) */}
      <div className="sarviz-right">
        <div className="sarviz-scene-wrap">
          {error ? (
            <div className="sarviz-error">SAR scene failed: {error}</div>
          ) : (
            <>
              <div ref={sceneHostRef} className="sarviz-scene nodrag nopan nowheel" />
              <div className="sarviz-telemetry">
                <div><span>Slant</span><b>{fmt(derived.slantRangeM / 1000)} km</b></div>
                <div><span>Ground</span><b>{fmt(derived.groundRangeM / 1000)} km</b></div>
                <div><span>Swath</span><b>{fmt(derived.swathM / 1000)} km</b></div>
                <div><span>RTT</span><b>{fmt(derived.roundTripMs, 2)} ms</b></div>
              </div>
            </>
          )}
        </div>

        {/* Horizontal splitter between 3D scene and timing diagram */}
        <div className="sarviz-splitter-h nodrag nopan" onPointerDown={dragTiming} title="Drag to resize" />

        <div className="sarviz-timing" style={{ height: `${timingH}px` }}>
          <div className="sarviz-timing-header">
            <span className="sarviz-section-title sarviz-timing-title">TIMING (TX / RX)</span>
            <button className="sarviz-play-btn nodrag nopan"
              onClick={(e) => { e.stopPropagation(); setRunning((r) => !r); }}
              title={running ? 'Pause' : 'Play'}>{running ? '❚❚' : '▶'}</button>
            <span className="sarviz-slowmo-label">slow-mo 1/{Math.round(1 / Math.pow(10, slowMoExp)).toLocaleString()}x</span>
            <input type="range" className="sarviz-slowmo nodrag nopan" min={-5} max={-2} step={0.1}
              value={slowMoExp}
              onChange={(e) => setSlowMoExp(parseFloat(e.target.value))}
              onMouseDown={(e) => e.stopPropagation()} />
            {/* Time-axis zoom: − widens the window (zoom out), + narrows it (zoom in) */}
            <div className="sarviz-zoom nodrag nopan">
              <button className="sarviz-zoom-btn" title="Zoom out (more time)"
                disabled={zoomIdx >= ZOOM_PRIS.length - 1}
                onClick={(e) => { e.stopPropagation(); setZoomIdx((i) => Math.min(ZOOM_PRIS.length - 1, i + 1)); }}>−</button>
              <button className="sarviz-zoom-btn" title="Zoom in (less time)"
                disabled={zoomIdx <= 0}
                onClick={(e) => { e.stopPropagation(); setZoomIdx((i) => Math.max(0, i - 1)); }}>+</button>
            </div>
          </div>
          <TimingDiagram timing={timing} clock={clockRef} windowPris={ZOOM_PRIS[zoomIdx]} />
        </div>
      </div>
    </div>
  );
}
