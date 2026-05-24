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

// ---- timing diagram (canvas 2D) -------------------------------------------
// Phase A: a simple PRF/pulse-width strip. Phase C ports the full TX/RX
// sub-band diagram from sar-visualizer's TimingDiagram.tsx.
function TimingStrip({ prfHz, pulseUs, derived }: {
  prfHz: number; pulseUs: number; derived: { roundTripMs: number };
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.max(w * dpr, 1); cv.height = Math.max(h * dpr, 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d1424';
    ctx.fillRect(0, 0, w, h);

    const pri_ms = 1000 / prfHz;           // pulse repetition interval [ms]
    const windowMs = pri_ms * 3.2;         // show ~3 PRIs
    const t0pad = 8, tEnd = w - 8;
    const xOf = (ms: number) => t0pad + (ms / windowMs) * (tEnd - t0pad);

    // ms grid
    ctx.strokeStyle = '#1d2940';
    ctx.fillStyle = '#5a6783';
    ctx.font = '9px ui-monospace, monospace';
    for (let ms = 0; ms <= windowMs; ms += pri_ms) {
      const x = xOf(ms);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }

    const txY = 14, rxY = h - 22, trackH = 12;
    ctx.fillStyle = '#8a9bb4';
    ctx.fillText('TX', 4, txY - 3);
    ctx.fillText('RX', 4, rxY - 3);

    // Draw pulses across the window.
    const pwMs = pulseUs / 1000;
    const rttMs = derived.roundTripMs;
    const echoMs = pwMs; // Phase A: echo as a single block (sub-band ramp in Phase C)
    for (let k = 0; k * pri_ms <= windowMs; k++) {
      const tTx = k * pri_ms;
      // TX block
      const xTx = xOf(tTx), wTx = Math.max(xOf(tTx + pwMs) - xTx, 1.5);
      ctx.fillStyle = '#5dd5ff';
      ctx.fillRect(xTx, txY, wTx, trackH);
      // RX block (delayed by round-trip)
      const tRx = tTx + rttMs;
      if (tRx <= windowMs) {
        const xRx = xOf(tRx), wRx = Math.max(xOf(tRx + echoMs) - xRx, 1.5);
        ctx.fillStyle = '#ff8c42';
        ctx.fillRect(xRx, rxY, wRx, trackH);
      }
    }
  });
  return <canvas ref={ref} className="sarviz-timing-canvas" />;
}

// ---- main widget body ------------------------------------------------------
export default function SarVisualizer({ params, paramDefs, onParamChange }: SarVisualizerProps) {
  const sceneHostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SarSceneHandle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sliderDefs = useMemo(() => paramDefs.filter((d) => d.dtype !== 'enum'), [paramDefs]);
  const enumDefs = useMemo(() => paramDefs.filter((d) => d.dtype === 'enum'), [paramDefs]);

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

  return (
    <div className="sarviz-body nodrag nopan nowheel"
      onWheel={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className="sarviz-main">
        {/* Left: parameter controls */}
        <div className="sarviz-controls">
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

        {/* Right: 3D scene + derived telemetry overlay */}
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
      </div>

      {/* Bottom: timing diagram */}
      <div className="sarviz-timing">
        <div className="sarviz-section-title sarviz-timing-title">TIMING (TX / RX)</div>
        <TimingStrip prfHz={prfHz} pulseUs={pulseUs} derived={derived} />
      </div>
    </div>
  );
}
