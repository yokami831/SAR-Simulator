/**
 * SurfaceRendererManager.ts
 *
 * Singleton that owns exactly ONE THREE.WebGLRenderer shared across all Surface3D
 * components. This avoids the browser's ~16 simultaneous WebGL context limit and
 * halves per-surface GPU memory overhead.
 *
 * Phase0 scope decision: The public API (register/dispose) is designed for multiple
 * concurrent surfaces (Map-based handle tracking, rAF starts/stops based on registered
 * count). However, the Phase0 rendering implementation is deliberately 1-surface-only:
 * it resizes the shared canvas to match the single registered element's bounding box
 * rather than using scissor/viewport to paint multiple sub-regions.
 * Full multi-surface scissored rendering will be implemented in Phase3 (the cost of a
 * targeted rewrite then is lower than building half-working generalisation now).
 */

import { INFERNO_256_FLAT } from '../colormap_inferno.js';

// We import three lazily (dynamic import) so that pages that never show a 3D
// surface don't pay the bundle cost. The import resolves once on first register().
// The module reference is cached so later register() calls are synchronous.
let THREE: typeof import('three') | null = null;

async function ensureThree(): Promise<typeof import('three')> {
  if (THREE) return THREE;
  try {
    THREE = await import('three');
    return THREE;
  } catch (err) {
    throw new Error(`three.js failed to load: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Plan A: shared GPU resources
//
// Memory plan: per-vertex position(12N) and color(12N) are dropped. Position is
// generated in the vertex shader from gl_VertexID (verified to work in this
// ANGLE context); height t is carried in the uv.x attribute (a custom attribute
// "aT" did NOT bind in r160 ShaderMaterial, but built-in uv does); color is
// computed in the fragment shader from a shared inferno LUT texture (fragment
// texture fetch works here even though vertex texture fetch does not). The
// triangle index is shared across same-(R,C) surfaces (acquireIndex/releaseIndex).
// Result: per-entry uv(8N) + one shared index(24N) per unique (R,C).
// ---------------------------------------------------------------------------

// Shared inferno LUT texture: 256×1 RGBA float, NEAREST, flipY=false.
// r160 removed RGBFormat, so the LUT must be 4-channel (768 rgb -> 1024 rgba).
// Built once, shared by ALL surfaces, reset to null on context loss.
let lutTexture: import('three').DataTexture | null = null;

function ensureLutTexture(T: typeof import('three')): import('three').DataTexture {
  if (lutTexture) return lutTexture;
  const rgba = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4] = INFERNO_256_FLAT[i * 3];
    rgba[i * 4 + 1] = INFERNO_256_FLAT[i * 3 + 1];
    rgba[i * 4 + 2] = INFERNO_256_FLAT[i * 3 + 2];
    rgba[i * 4 + 3] = 1.0;
  }
  const tex = new T.DataTexture(rgba, 256, 1, T.RGBAFormat, T.FloatType);
  tex.magFilter = T.NearestFilter;
  tex.minFilter = T.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  lutTexture = tex;
  return tex;
}

// Shared triangle-index cache, keyed `${R}x${C}`. Surfaces of identical (R,C)
// share ONE Uint32 index BufferAttribute. Refcounted: built on first acquire,
// GPU buffer freed (via a throwaway disposer geometry) when the last holder
// releases. Cleared wholesale on context loss (rebuilt lazily on restore).
interface IndexCacheEntry {
  attr: import('three').BufferAttribute;
  refcount: number;
}
const indexCache = new Map<string, IndexCacheEntry>();

function acquireIndex(T: typeof import('three'), R: number, C: number): import('three').BufferAttribute {
  const key = `${R}x${C}`;
  let e = indexCache.get(key);
  if (!e) {
    const quadCount = (R - 1) * (C - 1);
    const idx = new Uint32Array(quadCount * 6);
    let ii = 0;
    for (let r = 0; r < R - 1; r++) {
      for (let c = 0; c < C - 1; c++) {
        const a = r * C + c;
        const b = a + 1;
        const dd = a + C;
        const ee = dd + 1;
        idx[ii++] = a; idx[ii++] = dd; idx[ii++] = b;
        idx[ii++] = b; idx[ii++] = dd; idx[ii++] = ee;
      }
    }
    e = { attr: new T.BufferAttribute(idx, 1), refcount: 0 };
    indexCache.set(key, e);
  }
  e.refcount++;
  return e.attr;
}

function releaseIndex(T: typeof import('three'), R: number, C: number): void {
  const key = `${R}x${C}`;
  const e = indexCache.get(key);
  if (!e) return; // already cleared (e.g. by context loss) — safe no-op
  e.refcount--;
  if (e.refcount <= 0) {
    // Deterministically free the shared GL buffer: a throwaway geometry that
    // owns this index, disposed, fires the dispose event three uses to release
    // the GL buffer. Then drop the cache entry.
    const g = new T.BufferGeometry();
    g.setIndex(e.attr);
    g.dispose();
    indexCache.delete(key);
  }
}

// Plan A vertex shader. ShaderMaterial (NOT RawShaderMaterial) so three
// up-converts to GLSL3 on WebGL2, which makes gl_VertexID available. When
// drawing INDEXED, gl_VertexID == the index element value == flat k = r*C + c.
// Position is generated from k; height comes from uv.x. Reproduces the old CPU
// formulas exactly: x=c*invC-1, z=r*invR-1, y=t*H.
const SURF_VERT = `
  uniform float uH;
  uniform int uC;
  uniform int uR;
  uniform float invC;
  uniform float invR;
  varying float vT;
  void main() {
    int k = gl_VertexID;          // == r*C + c (index element value when indexed)
    int c = k - (k / uC) * uC;    // k % uC
    int r = k / uC;
    float t = uv.x;               // height carried in uv.x (uv.y unused)
    float x = (uC > 1) ? (float(c) * invC - 1.0) : 0.0;
    float z = (uR > 1) ? (float(r) * invR - 1.0) : 0.0;
    float y = t * uH;
    vT = t;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, z, 1.0);
  }
`;

// Plan A fragment shader. t -> inferno via the 256×1 LUT texture (NEAREST),
// reproducing the CPU index ((clamp(t)*255+0.5)|0) and the l<0.06 transparent
// floor. NaN -> 0 parity.
const SURF_FRAG = `
  uniform sampler2D uLut;
  varying float vT;
  void main() {
    float t = vT;
    float tc = (t < 0.0 || t != t) ? 0.0 : (t > 1.0 ? 1.0 : t);
    float idxf = floor(tc * 255.0 + 0.5);
    float u = (idxf + 0.5) / 256.0;
    vec3 vC = texture2D(uLut, vec2(u, 0.5)).rgb;
    float l = max(vC.r, max(vC.g, vC.b));
    if (l < 0.06) discard;
    gl_FragColor = vec4(vC, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SurfaceData {
  nrows: number;
  ncols: number;
  H: number;
  xr: [number, number];
  yr: [number, number];
  xlabel: string;
  ylabel: string;
  title: string;
  status: string | null;
  /** dBFS range that tv=[0,1] maps to (for colorbar labelling). Default -40..0. */
  dbVmin?: number;
  dbVmax?: number;
  /** dB-normalised scalar field, row-major, length = nrows * ncols, values in [0, 1] */
  field: Float32Array;
}

export interface SurfaceHandle {
  /** Replace the surface data and request a redraw. */
  setData(d: SurfaceData): void;
  /** Mark as dirty so the next rAF frame redraws. */
  requestRedraw(): void;
  /** Remove this surface from the manager and release GPU resources. */
  dispose(): void;
  /** Register a callback invoked when an unrecoverable error occurs. */
  onError(cb: (msg: string) => void): void;
}

// ---------------------------------------------------------------------------
// Internal entry tracked per registered surface
// ---------------------------------------------------------------------------

interface SurfaceEntry {
  el: HTMLElement;
  data: SurfaceData;
  dirty: boolean;
  errorCallbacks: Array<(msg: string) => void>;
  // GPU objects — null until THREE is loaded & first build
  mesh: import('three').Mesh | null;
  // Plan A: the `${R}x${C}` key of the shared index this entry currently holds a
  // ref on (null when no mesh). Used to release the right cache entry on rebuild
  // or teardown. R/C are parsed back from the key.
  indexKey: string | null;
  tickSprites: import('three').Sprite[];
  scene: import('three').Scene | null;
  camera: import('three').PerspectiveCamera | null;
  // Interaction state (spherical camera)
  sph: { r: number; theta: number; phi: number };
  target: import('three').Vector3 | null;
  // Listener cleanup
  pointerCleanup: (() => void) | null;
  resizeObserver: ResizeObserver | null;
}

// ---------------------------------------------------------------------------
// Manager singleton
// ---------------------------------------------------------------------------

export class SurfaceRendererManager {
  private static _instance: SurfaceRendererManager | null = null;

  static instance(): SurfaceRendererManager {
    if (!SurfaceRendererManager._instance) {
      SurfaceRendererManager._instance = new SurfaceRendererManager();
    }
    return SurfaceRendererManager._instance;
  }

  private canvas: HTMLCanvasElement | null = null;
  private renderer: import('three').WebGLRenderer | null = null;
  private rafId: number | null = null;
  private entries: Map<HTMLElement, SurfaceEntry> = new Map();
  private contextLost = false;

  private constructor() {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register an HTML element as a 3D surface display target.
   * Lazily imports three.js and sets up WebGL. Throws (rejects) on failure —
   * callers must display an error; no silent fallback.
   */
  async register(el: HTMLElement, data: SurfaceData): Promise<SurfaceHandle> {
    const T = await ensureThree();

    // Lazy-create the shared renderer canvas
    if (!this.renderer) {
      this._initRenderer(T);
    }

    // Build or replace entry
    const existingEntry = this.entries.get(el);
    if (existingEntry) {
      this._disposeEntryGPU(existingEntry, T);
    }

    const entry: SurfaceEntry = {
      el,
      data,
      dirty: true,
      errorCallbacks: existingEntry ? existingEntry.errorCallbacks : [],
      mesh: null,
      indexKey: null,
      tickSprites: [],
      scene: null,
      camera: null,
      sph: { r: 3.4, theta: Math.PI * 0.25, phi: Math.PI * 0.34 },
      target: null,
      pointerCleanup: null,
      resizeObserver: null,
    };

    this._buildScene(entry, T);
    this._attachInteraction(entry, T);
    this._attachResizeObserver(entry);

    this.entries.set(el, entry);
    this._ensureRAF();

    const handle: SurfaceHandle = {
      setData: (d: SurfaceData) => {
        entry.data = d;
        entry.dirty = true;
        this._rebuildMesh(entry, T);
        this._ensureRAF();
      },
      requestRedraw: () => {
        entry.dirty = true;
        this._ensureRAF();
      },
      dispose: () => {
        this._disposeEntry(el, T);
      },
      onError: (cb) => {
        entry.errorCallbacks.push(cb);
      },
    };

    return handle;
  }

  // -------------------------------------------------------------------------
  // Private — renderer lifecycle
  // -------------------------------------------------------------------------

  private _initRenderer(T: typeof import('three')): void {
    this.canvas = document.createElement('canvas');
    // Canvas is not attached to DOM; we use it via the renderer
    try {
      this.renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: true });
    } catch (err) {
      throw new Error(`WebGL unavailable: ${String(err)}`);
    }
    this.renderer.setClearColor(0x08090c);

    // Context lost / restored listeners
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this._stopRAF();
      // Shared GPU resources are gone with the context. Drop them so the restore
      // path rebuilds lazily. (Per-entry geometry/uv is rebuilt by _rebuildMesh
      // from the CPU-retained field; releaseIndex on a cleared key is a no-op.)
      lutTexture = null;
      indexCache.clear();
    });

    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      // Rebuild GPU buffers for all registered surfaces from their CPU-retained t fields
      import('three').then((T2) => {
        for (const entry of this.entries.values()) {
          this._rebuildMesh(entry, T2);
        }
        this._ensureRAF();
      }).catch((err) => {
        const msg = `WebGL context restored but three.js re-import failed: ${String(err)}`;
        for (const entry of this.entries.values()) {
          entry.errorCallbacks.forEach(cb => cb(msg));
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Private — scene building
  // -------------------------------------------------------------------------

  private _buildScene(entry: SurfaceEntry, T: typeof import('three')): void {
    const scene = new T.Scene();
    const W = entry.el.clientWidth || 300;
    const H = entry.el.clientHeight || 300;
    const camera = new T.PerspectiveCamera(50, W / H, 0.01, 100);
    entry.target = new T.Vector3(0, entry.data.H * 0.3, 0);

    // Grid
    const grid = new T.GridHelper(2, 16, 0x1c2230, 0x12161f);
    grid.position.y = -0.001;
    scene.add(grid);

    entry.scene = scene;
    entry.camera = camera;

    this._rebuildMesh(entry, T);
    this._updateCamera(entry);
  }

  private _rebuildMesh(entry: SurfaceEntry, T: typeof import('three')): void {
    if (!entry.scene) return;

    // Dispose old mesh. DETACH the shared index before geometry.dispose() so
    // three frees only the per-entry uv buffer, not the shared index GL buffer,
    // then release this entry's ref on the shared index.
    if (entry.mesh) {
      entry.scene.remove(entry.mesh);
      entry.mesh.geometry.setIndex(null);
      entry.mesh.geometry.dispose();
      (entry.mesh.material as import('three').Material).dispose();
      entry.mesh = null;
    }
    if (entry.indexKey) {
      const [rs, cs] = entry.indexKey.split('x');
      releaseIndex(T, parseInt(rs, 10), parseInt(cs, 10));
      entry.indexKey = null;
    }
    // Dispose old tick sprites
    for (const s of entry.tickSprites) {
      entry.scene.remove(s);
      if ((s.material as import('three').SpriteMaterial).map) {
        (s.material as import('three').SpriteMaterial).map!.dispose();
      }
      (s.material as import('three').SpriteMaterial).dispose();
    }
    entry.tickSprites = [];

    const d = entry.data;
    const R = d.nrows;
    const C = d.ncols;
    const tv = d.field;
    const H = d.H;
    const invC = C > 1 ? 2 / (C - 1) : 0; // x = c*invC - 1 (passed as uniform)
    const invR = R > 1 ? 2 / (R - 1) : 0; // z = r*invR - 1 (passed as uniform)

    // Plan A: no position/color buffers. Position is generated in the vertex
    // shader from gl_VertexID; color in the fragment shader from the LUT. The
    // only per-vertex buffer is uv (height in .x, .y unused). full resolution,
    // no downsampling.
    const uvArr = new Float32Array(R * C * 2);
    for (let k = 0; k < R * C; k++) uvArr[k * 2] = tv[k]; // uvArr[k*2+1] stays 0

    const geom = new T.BufferGeometry();
    geom.setAttribute('uv', new T.BufferAttribute(uvArr, 2));
    // Shared triangle index (one per unique (R,C)); count comes from index.count.
    geom.setIndex(acquireIndex(T, R, C));
    entry.indexKey = `${R}x${C}`;

    const mat = new T.ShaderMaterial({
      side: T.DoubleSide,
      uniforms: {
        uH: { value: H },
        uC: { value: C },
        uR: { value: R },
        invC: { value: invC },
        invR: { value: invR },
        uLut: { value: ensureLutTexture(T) },
      },
      vertexShader: SURF_VERT,
      fragmentShader: SURF_FRAG,
    });

    entry.mesh = new T.Mesh(geom, mat);
    // No position attribute => three cannot compute a bounding sphere, so
    // frustum culling would have no bounds and could drop the mesh. The surface
    // always lives in the ±1 box around the origin, so disable culling.
    entry.mesh.frustumCulled = false;
    entry.scene.add(entry.mesh);

    // Axis tick sprites (same positions as _SURF_TEMPLATE)
    const NT = 5;
    for (let i = 0; i < NT; i++) {
      const f = i / (NT - 1);
      const xv = d.xr[0] + (d.xr[1] - d.xr[0]) * f;
      const yv = d.yr[0] + (d.yr[1] - d.yr[0]) * f;
      entry.tickSprites.push(
        this._makeTickSprite(T, xv.toFixed(0), f * 2 - 1, -0.06, 1.12, '#9aa6bd', entry.scene!),
        this._makeTickSprite(T, yv.toFixed(0), -1.12, -0.06, f * 2 - 1, '#9aa6bd', entry.scene!),
      );
    }
    entry.tickSprites.push(
      this._makeTickSprite(T, d.xlabel, 0, -0.18, 1.30, '#cbd3e4', entry.scene!),
      this._makeTickSprite(T, d.ylabel, -1.34, -0.18, 0, '#cbd3e4', entry.scene!),
    );

    // Update camera target height on rebuild
    if (entry.target) entry.target.y = d.H * 0.3;

    entry.dirty = true;
  }

  private _makeTickSprite(
    T: typeof import('three'),
    text: string,
    x: number, y: number, z: number,
    color: string,
    scene: import('three').Scene,
  ): import('three').Sprite {
    const cn = document.createElement('canvas');
    cn.width = 128; cn.height = 32;
    const ctx = cn.getContext('2d')!;
    ctx.font = '20px sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 16);
    const tx = new T.CanvasTexture(cn);
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tx, depthTest: false }));
    sp.scale.set(0.5, 0.125, 1);
    sp.position.set(x, y, z);
    scene.add(sp);
    return sp;
  }

  // -------------------------------------------------------------------------
  // Private — camera update
  // -------------------------------------------------------------------------

  private _updateCamera(entry: SurfaceEntry): void {
    if (!entry.camera || !entry.target) return;
    const { r, theta, phi } = entry.sph;
    const tgt = entry.target;
    entry.camera.position.set(
      tgt.x + r * Math.sin(phi) * Math.cos(theta),
      tgt.y + r * Math.cos(phi),
      tgt.z + r * Math.sin(phi) * Math.sin(theta),
    );
    entry.camera.lookAt(tgt);
    entry.dirty = true;
    // The 2-mode rAF loop stops when nothing is dirty; camera changes from
    // pointer/wheel interaction must restart it or the view won't update.
    this._ensureRAF();
  }

  // -------------------------------------------------------------------------
  // Private — pointer interaction (matches _SURF_TEMPLATE exactly)
  // -------------------------------------------------------------------------

  private _attachInteraction(entry: SurfaceEntry, T: typeof import('three')): void {
    // We attach pointer events to the host element (the div), not the shared canvas
    const el = entry.el;
    let mode = 0;
    let pv = { x: 0, y: 0 };

    const onContextMenu = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    const onPointerDown = (e: PointerEvent) => {
      e.stopPropagation();
      mode = (e.button === 2 || e.button === 1) ? 2 : 1;
      pv = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const onPointerUp = (e: PointerEvent) => { e.stopPropagation(); mode = 0; };
    const onPointerMove = (e: PointerEvent) => {
      e.stopPropagation();
      if (!mode) return;
      const dx = e.clientX - pv.x;
      const dy = e.clientY - pv.y;
      pv = { x: e.clientX, y: e.clientY };
      if (mode === 1) {
        entry.sph.theta += dx * 0.01;
        entry.sph.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, entry.sph.phi - dy * 0.01));
      } else if (entry.camera && entry.target) {
        const right = new T.Vector3();
        const up = new T.Vector3();
        right.setFromMatrixColumn(entry.camera.matrixWorld, 0);
        up.setFromMatrixColumn(entry.camera.matrixWorld, 1);
        const k = entry.sph.r * 0.0016;
        entry.target.addScaledVector(right, -dx * k);
        entry.target.addScaledVector(up, dy * k);
      }
      this._updateCamera(entry);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      entry.sph.r *= e.deltaY > 0 ? 1.1 : 0.9;
      entry.sph.r = Math.max(0.2, Math.min(20, entry.sph.r));
      this._updateCamera(entry);
    };

    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('wheel', onWheel, { passive: false });

    entry.pointerCleanup = () => {
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('wheel', onWheel);
    };
  }

  // -------------------------------------------------------------------------
  // Private — resize observer (keep canvas sized to host element)
  // -------------------------------------------------------------------------

  private _attachResizeObserver(entry: SurfaceEntry): void {
    const ro = new ResizeObserver(() => {
      if (!this.renderer || !entry.camera) return;
      const W = entry.el.clientWidth || 300;
      const H = entry.el.clientHeight || 300;
      this.renderer.setSize(W, H);
      entry.camera.aspect = W / H;
      entry.camera.updateProjectionMatrix();
      entry.dirty = true;
      this._ensureRAF();
    });
    ro.observe(entry.el);
    entry.resizeObserver = ro;
  }

  // -------------------------------------------------------------------------
  // Private — rAF render loop
  // -------------------------------------------------------------------------

  private _ensureRAF(): void {
    if (this.rafId !== null || this.contextLost || this.entries.size === 0) return;
    this.rafId = requestAnimationFrame(() => this._renderFrame());
  }

  private _stopRAF(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private _renderFrame(): void {
    this.rafId = null;
    if (this.contextLost || !this.renderer) return;

    // Phase3: render EVERY dirty surface, not just the first. The single shared
    // renderer draws each entry at that entry's size, then the result is copied
    // into that entry's own host canvas (canvas.surface3d-target). Each host
    // canvas is independent, so no scissor/viewport is needed — one shared
    // WebGL context still serves any number of surfaces.
    for (const entry of this.entries.values()) {
      if (!entry.dirty || !entry.scene || !entry.camera) continue;
      const W = entry.el.clientWidth || 300;
      const H = entry.el.clientHeight || 300;
      // Always size the shared renderer to THIS entry before drawing it —
      // entries can differ in size, and renderer.domElement.width is
      // device-pixel-ratio scaled while W/H are CSS pixels, so a conditional
      // skip would render the wrong dimensions for the second+ surface.
      this.renderer.setSize(W, H, false);
      entry.camera.aspect = W / H;
      entry.camera.updateProjectionMatrix();
      this.renderer.render(entry.scene, entry.camera);

      // Copy the shared canvas into this entry's own host canvas.
      const hostCanvas = entry.el.querySelector('canvas.surface3d-target') as HTMLCanvasElement | null;
      if (hostCanvas) {
        const ctx2d = hostCanvas.getContext('2d');
        if (ctx2d) {
          hostCanvas.width = W;
          hostCanvas.height = H;
          ctx2d.drawImage(this.renderer.domElement, 0, 0);
        }
      }
      entry.dirty = false;
    }

    // Two-mode render loop: keep ticking only while something is still dirty
    // (pointer drag / resize set dirty every frame → continuous; once static,
    // nothing is dirty → loop stops until _ensureRAF() is called again).
    let stillDirty = false;
    for (const entry of this.entries.values()) {
      if (entry.dirty) { stillDirty = true; break; }
    }
    if (stillDirty) {
      this.rafId = requestAnimationFrame(() => this._renderFrame());
    }
  }

  // -------------------------------------------------------------------------
  // Private — disposal
  // -------------------------------------------------------------------------

  private _disposeEntryGPU(entry: SurfaceEntry, T: typeof import('three')): void {
    if (entry.mesh && entry.scene) {
      entry.scene.remove(entry.mesh);
      // Detach the shared index before dispose so three frees only the per-entry
      // uv buffer, not the shared index GL buffer.
      entry.mesh.geometry.setIndex(null);
      entry.mesh.geometry.dispose();
      (entry.mesh.material as import('three').Material).dispose();
      entry.mesh = null;
    }
    if (entry.indexKey) {
      const [rs, cs] = entry.indexKey.split('x');
      releaseIndex(T, parseInt(rs, 10), parseInt(cs, 10));
      entry.indexKey = null;
    }
    // The shared inferno LUT texture is NOT disposed here — it lives for the app
    // lifetime / is rebuilt on context restore.
    for (const s of entry.tickSprites) {
      entry.scene?.remove(s);
      const mat = s.material as import('three').SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    entry.tickSprites = [];
  }

  private _disposeEntry(el: HTMLElement, T: typeof import('three')): void {
    const entry = this.entries.get(el);
    if (!entry) return;

    this._disposeEntryGPU(entry, T);
    entry.pointerCleanup?.();
    entry.resizeObserver?.disconnect();
    this.entries.delete(el);

    // Stop rAF when no surfaces remain
    if (this.entries.size === 0) {
      this._stopRAF();
    }
  }

  /**
   * Called by Surface3D to signal an unrecoverable error to all registered entries.
   * (Used internally; not part of public API surface.)
   */
  _broadcastError(msg: string): void {
    for (const entry of this.entries.values()) {
      entry.errorCallbacks.forEach(cb => cb(msg));
    }
  }
}
