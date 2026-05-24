/**
 * SarSceneManager.ts
 *
 * Owns one THREE.WebGLRenderer + scene + camera for an embedded SAR
 * observation-geometry visualizer inside a flow node (ported, reduced, from
 * D:\Claude\sar-visualizer which is React-Three-Fiber based; here it is raw
 * three.js to match the existing Surface3D / SurfaceRendererManager pattern).
 *
 * Coordinate convention (identical to sar-visualizer physics/geometry.ts):
 *   x = azimuth (along-track), y = altitude (up), z = range (cross-track).
 *   Satellite at (azimuthM, altitudeM, 0); ground at y = 0; beam centre on the
 *   ground at z = altitudeM * tan(look).
 *   Scene scale: mToScene = 1 / 75_000  (1 unit = 75 km).
 *
 * Phase B scope: faithful satellite model (parabolic dish + bus + solar panels
 * + rim/horn/boom), real footprint-ellipse geometry, swath strip, slant/ground
 * range vectors, nadir line + ground ring. Phase C adds TX/RX pulses.
 *
 * Error behaviour: any failure (three load, WebGL unavailable) is thrown to the
 * caller (SarVisualizer.tsx) which renders a red error box. No silent fallback.
 */

import type * as THREE_NS from 'three';
import type { OrbitControls as OrbitControlsType } from 'three/examples/jsm/controls/OrbitControls.js';

// Lazy three import (same approach as SurfaceRendererManager).
let THREE: typeof THREE_NS | null = null;
let OrbitControlsCtor: typeof OrbitControlsType | null = null;

async function ensureThree(): Promise<typeof THREE_NS> {
  if (THREE) return THREE;
  THREE = (await import('three')) as typeof THREE_NS;
  return THREE;
}

async function ensureOrbitControls(): Promise<typeof OrbitControlsType> {
  if (OrbitControlsCtor) return OrbitControlsCtor;
  const mod = await import('three/examples/jsm/controls/OrbitControls.js');
  OrbitControlsCtor = mod.OrbitControls;
  return OrbitControlsCtor;
}

// Scene scale: 1 scene unit = 75 km (matches sar-visualizer's mToScene).
const M_TO_SCENE = 1 / 75_000;
const C = 299_792_458;
// Satellite visual size: exaggerated body length (sar-visualizer SAT_BODY_LENGTH_M).
const SAT_BODY_LENGTH_M = 25_000;

const m = (meters: number) => meters * M_TO_SCENE;

/** All SAR observation parameters the scene reads (SI units). */
export interface SarParams {
  altitudeM: number;     // H
  lookRad: number;       // look (off-nadir)
  beamAzRad: number;     // azimuth beam width
  beamRgRad: number;     // range (elevation) beam width
  satAzimuthM: number;   // along-track satellite displacement (0 = nadir at origin)
  obsMode: string;       // 'stripmap' | 'sliding' | 'spotlight' (Phase C uses it)
}

export interface SarSceneHandle {
  update(params: SarParams): void;
  dispose(): void;
  /** Derived read-outs for the telemetry panel. */
  derived(params: SarParams): SarDerived;
}

export interface SarDerived {
  slantRangeM: number;
  groundRangeM: number;
  swathM: number;
  roundTripMs: number;
}

/** Footprint extents (flat-earth), mirrors physics/geometry.ts footprintEllipse. */
interface Footprint {
  centerZ: number;     // ground range to beam centre [m]
  semiRange: number;   // half cross-track extent [m]
  semiAzimuth: number; // half along-track extent [m]
  gNear: number;       // near ground range [m]
  gFar: number;        // far ground range [m]
}

function footprint(p: SarParams): Footprint {
  const slant = p.altitudeM / Math.cos(p.lookRad);
  const semiAzimuth = (slant * p.beamAzRad) / 2;
  const thNear = p.lookRad - p.beamRgRad / 2;
  const thFar = p.lookRad + p.beamRgRad / 2;
  const gNear = p.altitudeM * Math.tan(thNear);
  const gFar = p.altitudeM * Math.tan(thFar);
  const centerZ = p.altitudeM * Math.tan(p.lookRad);
  const semiRange = (gFar - gNear) / 2;
  return { centerZ, semiRange, semiAzimuth, gNear, gFar };
}

/** Pure SAR geometry (subset of sar-visualizer physics/geometry.ts). */
export function computeDerived(p: SarParams): SarDerived {
  const slant = p.altitudeM / Math.cos(p.lookRad);
  const ground = p.altitudeM * Math.tan(p.lookRad);
  const fp = footprint(p);
  const swath = Math.abs(fp.gFar - fp.gNear);
  const roundTripMs = (2 * slant) / C * 1e3;
  return { slantRangeM: slant, groundRangeM: ground, swathM: swath, roundTripMs };
}

// ---------------------------------------------------------------------------
// Satellite model (faithful port of sar-visualizer Satellite.tsx).
// Built in a local frame where +Y is up and the dish opening points -Y (down).
// The parent group is rotated [-look, 0, azSteer] so the dish faces the ground.
// ---------------------------------------------------------------------------
function buildSatellite(T: typeof THREE_NS): THREE_NS.Group {
  const body = m(SAT_BODY_LENGTH_M); // ~0.333 scene units
  const grp = new T.Group();

  const std = (color: number, metalness: number, roughness: number,
               emissive?: number, emissiveIntensity?: number) => {
    const mat = new T.MeshStandardMaterial({ color, metalness, roughness });
    if (emissive !== undefined) { mat.emissive = new T.Color(emissive); mat.emissiveIntensity = emissiveIntensity ?? 1; }
    return mat;
  };

  // --- Bus / body ---
  const bodyH = body * (2 / 3);
  const bus = new T.Mesh(new T.BoxGeometry(body, bodyH, body), std(0xffcc55, 0.6, 0.3));
  grp.add(bus);

  // --- Solar panels x2 (cell plate + frame, simplified: no inner grid lines) ---
  const panelLen = body * 2.0;
  const panelWid = body * 0.8;
  const panelThk = body * 0.027;
  const panelOffsetX = body / 2 + panelLen / 2 + body * 0.033;
  const lineThk = body * 0.01;
  const frameH = panelThk * 1.12;
  const cellMat = std(0x3a6db0, 0.55, 0.35, 0x3a6db0, 0.55);
  const frameMat = std(0xc8d0e8, 0.3, 0.4, 0x6a7090, 0.45);
  for (const sign of [1, -1] as const) {
    const pg = new T.Group();
    pg.position.set(sign * panelOffsetX, 0, 0);
    const cell = new T.Mesh(new T.BoxGeometry(panelLen, panelThk, panelWid), cellMat);
    pg.add(cell);
    // long edges
    for (const z of [panelWid / 2 - lineThk / 2, -panelWid / 2 + lineThk / 2]) {
      const e = new T.Mesh(new T.BoxGeometry(panelLen, frameH, lineThk), frameMat);
      e.position.set(0, 0, z); pg.add(e);
    }
    // short edges
    for (const x of [panelLen / 2 - lineThk / 2, -panelLen / 2 + lineThk / 2]) {
      const e = new T.Mesh(new T.BoxGeometry(lineThk, frameH, panelWid), frameMat);
      e.position.set(x, 0, 0); pg.add(e);
    }
    grp.add(pg);
  }

  // --- Parabolic dish assembly (group scaled [1.6,1,1] for along-track elongation) ---
  const dishGrp = new T.Group();
  dishGrp.scale.set(1.6, 1, 1);
  const dishOriginY = -bodyH / 2 - body * 0.033;
  dishGrp.position.set(0, dishOriginY, 0);

  const R = body * 0.8;
  const f = body * 0.467;
  const sag = (R * R) / (4 * f);

  // Dish surface: LatheGeometry of the parabola y = r^2 / (4f), flipped to open -Y.
  const profile: THREE_NS.Vector2[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const r = (i / N) * R;
    profile.push(new T.Vector2(r, (r * r) / (4 * f)));
  }
  const dish = new T.Mesh(
    new T.LatheGeometry(profile, 48),
    std(0xe8e8ec, 0.4, 0.4),
  );
  (dish.material as THREE_NS.MeshStandardMaterial).side = T.DoubleSide;
  dish.rotation.x = Math.PI; // open downward
  dishGrp.add(dish);

  // Rim torus.
  const rim = new T.Mesh(new T.TorusGeometry(R, body * 0.017, 8, 48), std(0xb0b0b8, 0.7, 0.4));
  rim.position.set(0, -sag, 0);
  rim.rotation.x = Math.PI / 2;
  dishGrp.add(rim);

  // Feed horn.
  const horn = new T.Mesh(
    new T.CylinderGeometry(body * 0.067, body * 0.033, body * 0.147, 16),
    std(0xc8a050, 0.4, 0.5),
  );
  horn.position.set(0, -f + body * 0.073, 0);
  dishGrp.add(horn);

  // Support boom (rim edge -> focus).
  const rimPoint = new T.Vector3(R, -sag, 0);
  const focusPoint = new T.Vector3(0, -f, 0);
  const dir = new T.Vector3().subVectors(focusPoint, rimPoint);
  const boomLen = dir.length();
  const boom = new T.Mesh(
    new T.CylinderGeometry(body * 0.017, body * 0.017, boomLen, 8),
    std(0xb0b0b8, 0.7, 0.4),
  );
  boom.position.copy(rimPoint.clone().add(dir.clone().multiplyScalar(0.5)));
  boom.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.clone().normalize());
  dishGrp.add(boom);

  grp.add(dishGrp);
  return grp;
}

export async function createSarScene(host: HTMLDivElement): Promise<SarSceneHandle> {
  const T = await ensureThree();
  const OrbitControls = await ensureOrbitControls();

  const width = Math.max(host.clientWidth, 100);
  const height = Math.max(host.clientHeight, 100);

  const renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x05080f, 1);
  host.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';

  const scene = new T.Scene();

  const camera = new T.PerspectiveCamera(45, width / height, 0.05, 500);
  camera.position.set(-6, 9, 11);
  camera.lookAt(0, 2, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 1.5, 0);

  // Lights.
  scene.add(new T.AmbientLight(0xffffff, 0.55));
  const key = new T.DirectionalLight(0xfff2e0, 0.9);
  key.position.set(5, 10, 7);
  scene.add(key);
  const fill = new T.DirectionalLight(0xcfe0ff, 0.4);
  fill.position.set(-6, 4, -5);
  scene.add(fill);

  // Ground: dark plane + major/minor grids (sar-visualizer Ground.tsx).
  const GROUND_UNITS = 16;
  const ground = new T.Mesh(
    new T.PlaneGeometry(GROUND_UNITS, GROUND_UNITS),
    new T.MeshStandardMaterial({ color: 0x0a1220, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -m(1000);
  scene.add(ground);

  const gridMajor = new T.GridHelper(GROUND_UNITS, 30, 0x6a82b0, 0x3a5078);
  (gridMajor.material as THREE_NS.Material).transparent = true;
  (gridMajor.material as THREE_NS.Material & { opacity: number }).opacity = 0.45;
  gridMajor.position.y = -m(200);
  scene.add(gridMajor);

  // Nadir reference point on the ground.
  const originDot = new T.Mesh(
    new T.SphereGeometry(0.05, 16, 16),
    new T.MeshBasicMaterial({ color: 0x8a9bb4 }),
  );
  scene.add(originDot);

  // Nadir ground ring (annulus directly under the satellite).
  const nadirRing = new T.Mesh(
    new T.RingGeometry(m(18_000), m(28_000), 32),
    new T.MeshBasicMaterial({ color: 0x8a9bb4, transparent: true, opacity: 0.75, side: T.DoubleSide }),
  );
  nadirRing.rotation.x = -Math.PI / 2;
  nadirRing.position.y = m(2000);
  scene.add(nadirRing);

  // Satellite (faithful model).
  const satGroup = buildSatellite(T);
  scene.add(satGroup);

  // Nadir line (satellite -> point directly below).
  const nadirGeo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
  const nadirLine = new T.Line(nadirGeo, new T.LineBasicMaterial({ color: 0x8a9bb4, transparent: true, opacity: 0.55 }));
  scene.add(nadirLine);

  // Slant-range line (satellite -> beam centre on ground).
  const slantGeo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
  const slantLine = new T.Line(slantGeo, new T.LineBasicMaterial({ color: 0x5dd5ff, transparent: true, opacity: 0.85 }));
  scene.add(slantLine);

  // Ground-range line (nadir -> beam centre, on the ground).
  const groundRangeGeo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
  const groundRangeLine = new T.Line(groundRangeGeo, new T.LineBasicMaterial({ color: 0xaaccff, transparent: true, opacity: 0.7 }));
  scene.add(groundRangeLine);

  // Beam edges (4 lines satellite -> footprint extrema).
  const beamGeo = new T.BufferGeometry();
  beamGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(8 * 3), 3));
  const beamLines = new T.LineSegments(beamGeo, new T.LineBasicMaterial({ color: 0x00e6b4, transparent: true, opacity: 0.45 }));
  scene.add(beamLines);

  // Footprint ellipse fill (unit circle scaled to semiAz x semiRange).
  const fpFill = new T.Mesh(
    new T.CircleGeometry(1, 64),
    new T.MeshBasicMaterial({ color: 0x00e6b4, transparent: true, opacity: 0.22, side: T.DoubleSide, depthWrite: false }),
  );
  fpFill.rotation.x = -Math.PI / 2;
  scene.add(fpFill);

  // Footprint ellipse outline.
  const RING_SEG = 72;
  const fpRingGeo = new T.BufferGeometry();
  fpRingGeo.setAttribute('position', new T.BufferAttribute(new Float32Array((RING_SEG + 1) * 3), 3));
  const fpRing = new T.Line(fpRingGeo, new T.LineBasicMaterial({ color: 0x00e6b4, transparent: true, opacity: 0.95 }));
  scene.add(fpRing);

  // Swath strip (along-track band over the range extent).
  const swath = new T.Mesh(
    new T.PlaneGeometry(1, 1),
    new T.MeshBasicMaterial({ color: 0x00e6b4, transparent: true, opacity: 0.09, side: T.DoubleSide, depthWrite: false }),
  );
  swath.rotation.x = -Math.PI / 2;
  scene.add(swath);

  // ---- update logic --------------------------------------------------------
  let current: SarParams | null = null;

  function setLine(geo: THREE_NS.BufferGeometry, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const pos = geo.attributes.position.array as Float32Array;
    pos[0] = x0; pos[1] = y0; pos[2] = z0;
    pos[3] = x1; pos[4] = y1; pos[5] = z1;
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();
  }
  function setXYZ(arr: Float32Array, i: number, x: number, y: number, z: number) {
    arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
  }

  function update(p: SarParams) {
    current = p;
    const satX = m(p.satAzimuthM);
    const satY = m(p.altitudeM);
    const satZ = 0;

    satGroup.position.set(satX, satY, satZ);
    // Faithful satellite attitude: X rotation = -look (dish tilts toward +Z
    // range side), Z rotation = azimuth steering (0 in Phase B, stripmap).
    satGroup.rotation.set(-p.lookRad, 0, 0);

    originDot.position.set(satX, 0, satZ);
    nadirRing.position.set(satX, m(2000), satZ);

    const fp = footprint(p);
    const bcX = satX;                 // beam centre along-track = satellite (stripmap)
    const bcZ = m(fp.centerZ);

    // Nadir line.
    setLine(nadirGeo, satX, satY, satZ, satX, 0, satZ);
    // Slant line to beam centre.
    setLine(slantGeo, satX, satY, satZ, bcX, 0, bcZ);
    // Ground-range line (slightly above ground to avoid z-fighting).
    setLine(groundRangeGeo, satX, m(30), satZ, bcX, m(30), bcZ);

    const semiAz = m(fp.semiAzimuth);
    const semiRg = m(fp.semiRange);
    const zN = m(fp.gNear);
    const zF = m(fp.gFar);

    // Beam edges: satellite -> 4 footprint extrema (N/S along az, near/far range).
    const bPos = beamGeo.attributes.position.array as Float32Array;
    const extrema: Array<[number, number, number]> = [
      [bcX + semiAz, m(20), bcZ],
      [bcX - semiAz, m(20), bcZ],
      [bcX, m(20), zN],
      [bcX, m(20), zF],
    ];
    for (let i = 0; i < 4; i++) {
      setXYZ(bPos, i * 2, satX, satY, satZ);
      setXYZ(bPos, i * 2 + 1, extrema[i][0], extrema[i][1], extrema[i][2]);
    }
    beamGeo.attributes.position.needsUpdate = true;
    beamGeo.computeBoundingSphere();

    // Footprint ellipse fill: unit circle scaled to (semiAz, semiRange).
    fpFill.position.set(bcX, m(18), bcZ);
    fpFill.scale.set(semiAz, semiRg, 1);

    // Footprint ellipse outline.
    const ringPos = fpRingGeo.attributes.position.array as Float32Array;
    for (let i = 0; i <= RING_SEG; i++) {
      const a = (i / RING_SEG) * Math.PI * 2;
      setXYZ(ringPos, i, bcX + semiAz * Math.cos(a), m(25), bcZ + semiRg * Math.sin(a));
    }
    fpRingGeo.attributes.position.needsUpdate = true;
    fpRingGeo.computeBoundingSphere();

    // Swath strip: along-track length (cover visible band) x range extent.
    const swathLenAz = GROUND_UNITS * 0.9; // scene units, generous along-track band
    swath.position.set(bcX, m(15), bcZ);
    swath.scale.set(swathLenAz, Math.max(zF - zN, 1e-3), 1);
  }

  // ---- render loop ---------------------------------------------------------
  let raf = 0;
  let disposed = false;
  function tick() {
    if (disposed) return;
    controls.update();
    const w = host.clientWidth, h = host.clientHeight;
    if (w > 0 && h > 0) {
      const size = renderer.getSize(new T.Vector2());
      if (Math.abs(size.x - w) > 1 || Math.abs(size.y - h) > 1) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  return {
    update,
    derived: computeDerived,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      controls.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE_NS.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE_NS.Material | THREE_NS.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else if (mat) mat.dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }
      void current;
    },
  };
}
