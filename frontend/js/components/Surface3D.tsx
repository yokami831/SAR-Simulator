/**
 * Surface3D.tsx
 *
 * React component that renders the new mime type:
 *   application/x-hiyocanvas-surface3d
 *
 * Supports two payload kinds:
 *   - "single": one surface (field_b64). Phase0.
 *   - "pair":   two surfaces a (Full) / b (Crop) with a toggle. Phase2.
 *
 * Receives payloadJson (the JSON string from the kernel), decodes the base64
 * field_b64 into a Float32Array, and hands it to SurfaceRendererManager.
 * All 3D rendering goes through the shared single WebGLRenderer; no iframes.
 *
 * G1 fix: host div carries "nodrag nopan" so React Flow does not steal
 * pointer events from the 3D canvas. SurfaceRendererManager._attachInteraction
 * additionally calls stopPropagation on all pointer/wheel/contextmenu events.
 *
 * Error behaviour: any failure (JSON parse, base64 decode, three.js load,
 * WebGL unavailable, context lost/not-restored) is displayed as a red error
 * box. There is NO silent fallback to the iframe-based surface3d. This follows
 * CLAUDE.md "No fallbacks / No silent errors".
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { SurfaceRendererManager, SurfaceHandle, SurfaceData } from './SurfaceRendererManager.js';
import { INFERNO_256 } from '../colormap_inferno.js';
import { Z_MODAL_OVERLAY } from '../constants.js';

// ---------------------------------------------------------------------------
// Payload schema (must match backend _emit_surface_gl / surface3d_pair_gl)
// ---------------------------------------------------------------------------

interface SubPayload {
  title: string;
  status: string | null;
  nrows: number;
  ncols: number;
  H: number;
  xr: [number, number];
  yr: [number, number];
  xlabel: string;
  ylabel: string;
  dtype: string;   // "float32"
  db_vmin?: number;  // dBFS at tv=0 (default -40)
  db_vmax?: number;  // dBFS at tv=1 (default 0)
  field_b64: string;
}

interface SinglePayload extends SubPayload {
  kind: 'single';
}

interface PairPayload {
  kind: 'pair';
  a: SubPayload;
  b: SubPayload;
}

type Surface3DPayload = SinglePayload | PairPayload;

// ---------------------------------------------------------------------------
// Helper — decode a SubPayload's field_b64 into a SurfaceData + Float32Array.
// Throws a string error on failure (caller displays it).
// The base64 string reference is released after decode (GC can reclaim it).
// ---------------------------------------------------------------------------

function decodeSubPayload(sub: SubPayload): SurfaceData {
  let field: Float32Array;
  try {
    const raw = atob(sub.field_b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    field = new Float32Array(bytes.buffer);
  } catch (err) {
    throw `surface3d: base64 decode failed: ${String(err)}`;
  }

  const expected = sub.nrows * sub.ncols;
  if (field.length !== expected) {
    throw `surface3d: field length mismatch: got ${field.length}, expected ${expected}`;
  }

  return {
    nrows: sub.nrows,
    ncols: sub.ncols,
    H: sub.H,
    xr: sub.xr,
    yr: sub.yr,
    xlabel: sub.xlabel,
    ylabel: sub.ylabel,
    title: sub.title,
    status: sub.status,
    dbVmin: sub.db_vmin,
    dbVmax: sub.db_vmax,
    field,
  };
}

// ---------------------------------------------------------------------------
// Colorbar SVG (matches _SURF_TEMPLATE exactly)
// ---------------------------------------------------------------------------

const BAR_H = 120;
const BAR_W = 12;
const PAD_TOP = 6;
const GS = 24; // gradient stops

// Choose a "nice" tick step (e.g. 10, 20, 25) that gives roughly 4–6 labels.
function niceTickStep(range: number, target: number = 5): number {
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  let step: number;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  return step * pow;
}

function ColorBar({ dbVmin = -40, dbVmax = 0 }: { dbVmin?: number; dbVmax?: number }): React.ReactElement {
  // Build gradient stops using the same 256-entry LUT as the 3D surface
  const stops: React.ReactElement[] = [];
  for (let i = 0; i <= GS; i++) {
    const frac = i / GS;
    const t = 1 - frac;
    const idx = Math.max(0, Math.min(255, Math.round(t * 255)));
    const [r, g, b] = INFERNO_256[idx];
    stops.push(
      <stop
        key={i}
        offset={`${frac * 100}%`}
        stopColor={`rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`}
      />
    );
  }

  // Dynamic dB tick marks across [dbVmin, dbVmax]; tv=0 -> bottom, tv=1 -> top.
  const range = dbVmax - dbVmin;
  const step = range > 0 ? niceTickStep(range) : 10;
  const tickStart = Math.ceil(dbVmin / step) * step;
  const ticks: React.ReactElement[] = [];
  for (let db = tickStart; db <= dbVmax + 1e-6; db += step) {
    const frac = (db - dbVmin) / range; // 0 at bottom
    const y = PAD_TOP + (1 - frac) * BAR_H;
    ticks.push(
      <React.Fragment key={db}>
        <line x1={BAR_W} y1={y} x2={BAR_W + 3} y2={y} stroke="#6c7894" strokeWidth={1} />
        <text x={BAR_W + 6} y={y + 3} fill="#cfd6e6" fontSize={9}>{db >= 0 ? `+${db}` : `${db}`}</text>
      </React.Fragment>
    );
  }

  return (
    <div style={{
      position: 'absolute', top: 12, right: 12,
      background: 'rgba(14,20,34,0.85)', border: '1px solid #2a3142',
      borderRadius: 6, padding: '5px 7px',
      color: '#cfd6e6', font: '10px/1.2 system-ui,sans-serif', userSelect: 'none',
    }}>
      <div style={{ marginBottom: 3, color: '#9aa4ba' }}>[dBFS]</div>
      <svg width="44" height="136" style={{ display: 'block' }}>
        <defs>
          <linearGradient id="inf-bar" x1="0" y1="0" x2="0" y2="1">
            {stops}
          </linearGradient>
        </defs>
        <rect x={0} y={PAD_TOP} width={BAR_W} height={BAR_H}
          fill="url(#inf-bar)" stroke="#2a3142" strokeWidth={1} />
        {ticks}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full/Crop toggle buttons (pair mode only)
// Matches _SURF_PAIR_TEMPLATE position: top:8 left:10 margin-top:22px
// ---------------------------------------------------------------------------

interface ToggleButtonsProps {
  active: 'a' | 'b';
  onToggle: (which: 'a' | 'b') => void;
}

function ToggleButtons({ active, onToggle }: ToggleButtonsProps): React.ReactElement {
  const activeStyle: React.CSSProperties = {
    background: '#1b2740', border: '1px solid #2a3142',
    color: '#cfd6e6', font: '11px sans-serif', padding: '3px 10px', cursor: 'pointer',
  };
  const inactiveStyle: React.CSSProperties = {
    background: 'rgba(14,20,34,0.85)', border: '1px solid #2a3142',
    color: '#cfd6e6', font: '11px sans-serif', padding: '3px 10px', cursor: 'pointer',
  };
  return (
    <div style={{
      position: 'absolute', top: 8, left: 10, marginTop: 22,
      display: 'flex', gap: 0,
    }}>
      <button
        style={{ ...active === 'a' ? activeStyle : inactiveStyle, borderRight: 'none', borderRadius: '4px 0 0 4px' }}
        onClick={() => onToggle('a')}
      >Full</button>
      <button
        style={{ ...active === 'b' ? activeStyle : inactiveStyle, borderRadius: '0 4px 4px 0' }}
        onClick={() => onToggle('b')}
      >Crop</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expand modal (React-based, re-uses same typed array — no copy)
// ---------------------------------------------------------------------------

interface ExpandModalProps {
  // For single: surfaceData is the one SurfaceData.
  // For pair: surfaceData is the currently-active sub, dataA/dataB are both subs.
  surfaceData: SurfaceData;
  isPair: boolean;
  dataA: SurfaceData | null;
  dataB: SurfaceData | null;
  onClose: () => void;
}

function ExpandModal({ surfaceData, isPair, dataA, dataB, onClose }: ExpandModalProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<SurfaceHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'a' | 'b'>('a');

  // Determine initial data: for pair, start with 'a'
  const initialData = (isPair && dataA) ? dataA : surfaceData;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let disposed = false;
    SurfaceRendererManager.instance()
      .register(el, initialData)
      .then(h => {
        if (disposed) { h.dispose(); return; }
        handleRef.current = h;
        h.onError(msg => setError(msg));
      })
      .catch(err => setError(String(err)));
    return () => {
      disposed = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggle = useCallback((which: 'a' | 'b') => {
    setActiveTab(which);
    const newData = which === 'a' ? dataA : dataB;
    if (newData && handleRef.current) {
      handleRef.current.setData(newData);
    }
  }, [dataA, dataB]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: Z_MODAL_OVERLAY,
      background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onClick={onClose}
    >
      <div style={{
        width: '90vw', height: '85vh', position: 'relative',
        background: '#08090c', borderRadius: 8, overflow: 'hidden',
      }}
        onClick={e => e.stopPropagation()}
      >
        {error ? (
          <div style={{ color: '#ff6b6b', padding: 16, fontFamily: 'monospace', fontSize: 13 }}>
            {error}
          </div>
        ) : (
          // G1: nodrag nopan prevents React Flow from stealing pointer events in modal too
          <div ref={hostRef} className="nodrag nopan" style={{ width: '100%', height: '100%', position: 'relative' }}>
            <canvas className="surface3d-target"
              style={{ width: '100%', height: '100%', display: 'block' }} />
            <ColorBar dbVmin={(isPair ? (activeTab === 'b' ? dataB : dataA) : surfaceData)?.dbVmin}
                      dbVmax={(isPair ? (activeTab === 'b' ? dataB : dataA) : surfaceData)?.dbVmax} />
            {isPair && dataA && dataB && (
              <ToggleButtons active={activeTab} onToggle={handleToggle} />
            )}
          </div>
        )}
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 8, right: 8,
            background: 'rgba(14,20,34,0.85)', border: '1px solid #2a3142',
            borderRadius: 4, color: '#cfd6e6', font: '11px sans-serif',
            padding: '3px 8px', cursor: 'pointer',
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Surface3D component
// ---------------------------------------------------------------------------

interface Surface3DProps {
  payloadJson: string;
}

export function Surface3D({ payloadJson }: Surface3DProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<SurfaceHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showExpand, setShowExpand] = useState(false);

  // For single: surfaceDataRef holds the one SurfaceData.
  // For pair: dataARef / dataBRef hold a/b subs; surfaceDataRef holds the active one.
  const surfaceDataRef = useRef<SurfaceData | null>(null);
  const dataARef = useRef<SurfaceData | null>(null);
  const dataBRef = useRef<SurfaceData | null>(null);
  // isPair is STATE (not ref) so the Full/Crop toggle re-renders when decode
  // determines kind. A ref would not trigger a re-render and the toggle would
  // not appear.
  const [isPair, setIsPair] = useState(false);

  // Toggle state (pair mode only)
  const [activeTab, setActiveTab] = useState<'a' | 'b'>('a');

  // Parse payload and decode field_b64 — done once per payloadJson change
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    let disposed = false;
    let handle: SurfaceHandle | null = null;

    (async () => {
      // 1. Parse JSON — explicit error, no silent catch
      let payload: Surface3DPayload;
      try {
        payload = JSON.parse(payloadJson) as Surface3DPayload;
      } catch (err) {
        setError(`surface3d: failed to parse payload JSON: ${String(err)}`);
        setLoading(false);
        return;
      }

      // 2. Decode — branch on kind
      let initialData: SurfaceData;
      try {
        if (payload.kind === 'pair') {
          setIsPair(true);
          dataARef.current = decodeSubPayload(payload.a);
          dataBRef.current = decodeSubPayload(payload.b);
          // Start with 'a' (Full)
          initialData = dataARef.current;
          surfaceDataRef.current = initialData;
          setActiveTab('a');
        } else if (payload.kind === 'single') {
          setIsPair(false);
          dataARef.current = null;
          dataBRef.current = null;
          initialData = decodeSubPayload(payload as SubPayload);
          surfaceDataRef.current = initialData;
        } else {
          // Unknown kind — explicit error, NO silent fallback to single (CLAUDE.md)
          throw new Error(`surface3d: unknown payload kind: ${String((payload as { kind?: unknown }).kind)}`);
        }
      } catch (err) {
        setError(String(err));
        setLoading(false);
        return;
      }

      // 3. Register with the shared renderer manager
      try {
        handle = await SurfaceRendererManager.instance().register(el, initialData);
        if (disposed) { handle.dispose(); return; }
        handleRef.current = handle;
        handle.onError(msg => setError(msg));
        setLoading(false);
      } catch (err) {
        // Covers: three.js import failure, WebGL unavailable
        setError(String(err));
        setLoading(false);
      }
    })();

    return () => {
      disposed = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [payloadJson]);

  // Toggle handler (pair mode): swap a/b SurfaceData via setData (mesh rebuild, camera kept)
  const handleToggle = useCallback((which: 'a' | 'b') => {
    setActiveTab(which);
    const newData = which === 'a' ? dataARef.current : dataBRef.current;
    if (newData && handleRef.current) {
      surfaceDataRef.current = newData;
      handleRef.current.setData(newData);
    }
  }, []);

  const openExpand = useCallback(() => setShowExpand(true), []);
  const closeExpand = useCallback(() => setShowExpand(false), []);

  // Title/status follow the ACTIVE sub (Full=a / Crop=b) so the toggle updates
  // the overlay too (e.g. Crop shows its "upsample x6" status, not Full's).
  // Prefer the decoded SurfaceData (kept per-sub); fall back to parsing the
  // payload for the very first render before decode completes.
  let title = '';
  let status: string | null = null;
  const activeData = activeTab === 'b' ? dataBRef.current : dataARef.current;
  if (activeData) {
    title = activeData.title;
    status = activeData.status;
  } else {
    try {
      const p = JSON.parse(payloadJson) as Record<string, unknown>;
      if (p.kind === 'pair') {
        const sub = (activeTab === 'b' ? p.b : p.a) as Partial<SubPayload>;
        title = sub?.title ?? '';
        status = sub?.status ?? null;
      } else {
        title = (p.title as string) ?? '';
        status = (p.status as string | null) ?? null;
      }
    } catch (_) { /* only for display labels — ignored */ }
  }

  if (error) {
    // Red error box — no fallback to iframe
    return (
      <div style={{
        margin: '4px 0', padding: '8px 12px',
        background: '#2a0a0a', border: '1px solid #ff4444',
        borderRadius: 4, color: '#ff6b6b',
        fontFamily: 'monospace', fontSize: 12,
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      }}>
        {error}
      </div>
    );
  }

  return (
    <>
      <div style={{
        position: 'relative', width: '100%', height: 480,
        background: '#08090c', marginTop: 4, borderRadius: 2,
      }}>
        {/*
          G1 fix: "nodrag nopan" prevents React Flow from intercepting pointer
          events that land on the 3D canvas host. Combined with stopPropagation
          in SurfaceRendererManager._attachInteraction, drag/wheel events stay
          in the 3D renderer and do not move/pan the React Flow canvas.
        */}
        <div
          ref={hostRef}
          className="nodrag nopan"
          style={{ width: '100%', height: '100%', position: 'relative' }}
        >
          {/* Target canvas — the manager's rAF loop draws into this via drawImage */}
          <canvas
            className="surface3d-target"
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </div>

        {/* Colorbar (SVG, ticks/labels follow the active sub's dBFS range) */}
        <ColorBar dbVmin={activeData?.dbVmin} dbVmax={activeData?.dbVmax} />

        {/* Title overlay */}
        {title && (
          <div style={{
            position: 'absolute', top: 8, left: 10,
            color: '#cbd3e4', font: '13px sans-serif', pointerEvents: 'none',
          }}>
            {title}
          </div>
        )}

        {/* Full/Crop toggle (pair mode only) — position matches _SURF_PAIR_TEMPLATE */}
        {!loading && isPair && (
          <ToggleButtons active={activeTab} onToggle={handleToggle} />
        )}

        {/* Status overlay — show current sub's status */}
        {status && (
          <div style={{
            position: 'absolute', bottom: 8, right: 10,
            background: 'rgba(14,20,34,0.8)', border: '1px solid #2a3142',
            borderRadius: 4, padding: '2px 8px',
            font: '11px sans-serif', color: '#9aa6bd',
          }}>
            {status}
          </div>
        )}

        {/* Loading indicator */}
        {loading && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#9aa6bd', font: '13px sans-serif',
          }}>
            Loading 3D...
          </div>
        )}

        {/* Expand button (matches _SURF_TEMPLATE position: top:8 right:64) */}
        {!loading && (
          <button
            onClick={openExpand}
            title="Open in expanded view"
            style={{
              position: 'absolute', top: 8, right: 64,
              background: 'rgba(14,20,34,0.85)', border: '1px solid #2a3142',
              borderRadius: 4, color: '#cfd6e6', font: '11px sans-serif',
              padding: '3px 8px', cursor: 'pointer',
            }}
          >
            ⤢ Expand
          </button>
        )}
      </div>

      {/* Expand modal — same typed arrays, no copy */}
      {showExpand && surfaceDataRef.current && (
        <ExpandModal
          surfaceData={surfaceDataRef.current}
          isPair={isPair}
          dataA={dataARef.current}
          dataB={dataBRef.current}
          onClose={closeExpand}
        />
      )}
    </>
  );
}

export default Surface3D;
