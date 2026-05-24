/**
 * SarSceneManager.ts
 *
 * Owns one THREE.WebGLRenderer + scene + camera for an embedded SAR
 * observation-geometry visualizer inside a flow node (ported, reduced, from
 * D:\Claude\sar-visualizer which is React-Three-Fiber based; here it is raw
 * three.js to match the existing Surface3D / SurfaceRendererManager pattern).
 *
 * Phase A scope: a skeleton scene that already reacts to the real observation
 * parameters so the layout and interactivity can be judged in the app:
 *   - grid ground plane (dark) + axis hint
 *   - satellite marker at [azimuth, altitude] (scene scale 1 unit = 75 km)
 *   - nadir line (satellite -> ground)
 *   - slant-range line at the look angle (satellite -> beam centre)
 *   - footprint rectangle on the ground sized from beam Az/Rg widths
 *   - orbit-controls (mouse drag = orbit, wheel = zoom)
 *
 * Phase B will replace the satellite marker with the parabolic-dish model and
 * add the swath/range-vector decorations + TX/RX pulses.
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

/** All SAR observation parameters the scene reads (SI units). */
export interface SarParams {
  altitudeM: number;     // H
  lookRad: number;       // look (off-nadir)
  beamAzRad: number;     // azimuth beam width
  beamRgRad: number;     // range (elevation) beam width
  satAzimuthM: number;   // along-track satellite displacement (0 = nadir at origin)
  obsMode: string;       // 'stripmap' | 'sliding' | 'spotlight' (Phase B uses it)
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

/** Pure SAR geometry (subset of sar-visualizer physics/geometry.ts). */
export function computeDerived(p: SarParams): SarDerived {
  // Flat-earth approximation (educational; matches the original tool's scope).
  const slant = p.altitudeM / Math.cos(p.lookRad);
  const ground = p.altitudeM * Math.tan(p.lookRad);
  // Near/far ground range from the +/- half range-beam edges.
  const lookNear = p.lookRad - p.beamRgRad / 2;
  const lookFar = p.lookRad + p.beamRgRad / 2;
  const gNear = p.altitudeM * Math.tan(lookNear);
  const gFar = p.altitudeM * Math.tan(lookFar);
  const swath = Math.abs(gFar - gNear);
  const roundTripMs = (2 * slant) / C * 1e3;
  return { slantRangeM: slant, groundRangeM: ground, swathM: swath, roundTripMs };
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

  // Ground: dark plane + grid. Grid spans 16 units (1200 km) centred at origin.
  const GROUND_UNITS = 16;
  const groundGeo = new T.PlaneGeometry(GROUND_UNITS, GROUND_UNITS);
  const groundMat = new T.MeshStandardMaterial({ color: 0x0a1220, roughness: 1, metalness: 0 });
  const ground = new T.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new T.GridHelper(GROUND_UNITS, GROUND_UNITS, 0x2a4a6a, 0x18293f);
  (grid.material as THREE_NS.Material).transparent = true;
  (grid.material as THREE_NS.Material & { opacity: number }).opacity = 0.6;
  scene.add(grid);

  // Axis hint at origin (nadir reference point on the ground).
  const originDot = new T.Mesh(
    new T.SphereGeometry(0.06, 16, 16),
    new T.MeshBasicMaterial({ color: 0x5dd5ff }),
  );
  scene.add(originDot);

  // Satellite marker (Phase A placeholder: small box; Phase B = dish model).
  const satGroup = new T.Group();
  const satBody = new T.Mesh(
    new T.BoxGeometry(0.35, 0.18, 0.6),
    new T.MeshStandardMaterial({ color: 0xd8b25a, roughness: 0.5, metalness: 0.3 }),
  );
  satGroup.add(satBody);
  // Solar-panel hint.
  const panel = new T.Mesh(
    new T.BoxGeometry(1.4, 0.02, 0.35),
    new T.MeshStandardMaterial({ color: 0x244a8a, roughness: 0.4, metalness: 0.5 }),
  );
  satGroup.add(panel);
  scene.add(satGroup);

  // Nadir line (satellite -> point directly below).
  const nadirMat = new T.LineBasicMaterial({ color: 0x46566f });
  const nadirGeo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
  const nadirLine = new T.Line(nadirGeo, nadirMat);
  scene.add(nadirLine);

  // Slant-range line (satellite -> beam centre on ground).
  const slantMat = new T.LineBasicMaterial({ color: 0x00e6b4 });
  const slantGeo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
  const slantLine = new T.Line(slantGeo, slantMat);
  scene.add(slantLine);

  // Beam edges (4 lines satellite -> footprint corners).
  const beamMat = new T.LineBasicMaterial({ color: 0x00e6b4, transparent: true, opacity: 0.5 });
  const beamGeo = new T.BufferGeometry();
  // 4 corners * 2 points (sat, corner) = 8 vertices.
  beamGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(8 * 3), 3));
  const beamLines = new T.LineSegments(beamGeo, beamMat);
  scene.add(beamLines);

  // Footprint rectangle outline on the ground.
  const fpMat = new T.LineBasicMaterial({ color: 0xffc344 });
  const fpGeo = new T.BufferGeometry();
  fpGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(5 * 3), 3)); // closed loop
  const footprint = new T.Line(fpGeo, fpMat);
  scene.add(footprint);

  // Footprint fill (semi-transparent).
  const fpFillMat = new T.MeshBasicMaterial({ color: 0xffc344, transparent: true, opacity: 0.12, side: T.DoubleSide });
  const fpFill = new T.Mesh(new T.PlaneGeometry(1, 1), fpFillMat);
  fpFill.rotation.x = -Math.PI / 2;
  scene.add(fpFill);

  // ---- update logic --------------------------------------------------------
  let current: SarParams | null = null;

  function update(p: SarParams) {
    current = p;
    const satX = p.satAzimuthM * M_TO_SCENE;
    const satY = p.altitudeM * M_TO_SCENE;
    const satZ = 0;

    // Satellite position. The beam points in +Z (range/cross-track) and down.
    satGroup.position.set(satX, satY, satZ);

    // Beam centre on the ground (flat earth): ground range in +Z.
    const groundRange = p.altitudeM * Math.tan(p.lookRad);
    const bcX = satX;
    const bcZ = groundRange * M_TO_SCENE;

    // Nadir line.
    setLine(nadirGeo, satX, satY, satZ, satX, 0, satZ);

    // Slant line to beam centre.
    setLine(slantGeo, satX, satY, satZ, bcX, 0, bcZ);

    // Footprint extents (flat earth).
    const lookNear = p.lookRad - p.beamRgRad / 2;
    const lookFar = p.lookRad + p.beamRgRad / 2;
    const gNear = p.altitudeM * Math.tan(lookNear) * M_TO_SCENE;
    const gFar = p.altitudeM * Math.tan(lookFar) * M_TO_SCENE;
    const slant = p.altitudeM / Math.cos(p.lookRad);
    const halfAz = (slant * p.beamAzRad / 2) * M_TO_SCENE;

    const zN = gNear, zF = gFar;
    const xL = satX - halfAz, xR = satX + halfAz;

    // Footprint outline (closed loop): 4 corners + return.
    const fpPos = fpGeo.attributes.position.array as Float32Array;
    setXYZ(fpPos, 0, xL, 0.005, zN);
    setXYZ(fpPos, 1, xR, 0.005, zN);
    setXYZ(fpPos, 2, xR, 0.005, zF);
    setXYZ(fpPos, 3, xL, 0.005, zF);
    setXYZ(fpPos, 4, xL, 0.005, zN);
    fpGeo.attributes.position.needsUpdate = true;
    fpGeo.computeBoundingSphere();

    // Footprint fill plane.
    fpFill.position.set((xL + xR) / 2, 0.004, (zN + zF) / 2);
    fpFill.scale.set(Math.max(xR - xL, 1e-3), Math.max(zF - zN, 1e-3), 1);

    // Beam edges: satellite -> each footprint corner.
    const bPos = beamGeo.attributes.position.array as Float32Array;
    const corners: Array<[number, number, number]> = [
      [xL, 0, zN], [xR, 0, zN], [xR, 0, zF], [xL, 0, zF],
    ];
    for (let i = 0; i < 4; i++) {
      setXYZ(bPos, i * 2, satX, satY, satZ);
      setXYZ(bPos, i * 2 + 1, corners[i][0], corners[i][1], corners[i][2]);
    }
    beamGeo.attributes.position.needsUpdate = true;
    beamGeo.computeBoundingSphere();

    // Aim satellite body toward beam centre (simple tilt by look angle).
    satGroup.rotation.set(0, 0, -p.lookRad);
  }

  function setLine(geo: THREE_NS.BufferGeometry, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const pos = geo.attributes.position.array as Float32Array;
    setXYZ(pos, 0, x0, y0, z0);
    setXYZ(pos, 1, x1, y1, z1);
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();
  }

  function setXYZ(arr: Float32Array, i: number, x: number, y: number, z: number) {
    arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
  }

  // ---- render loop ---------------------------------------------------------
  let raf = 0;
  let disposed = false;
  function tick() {
    if (disposed) return;
    controls.update();
    // Track host resize.
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
        const m = obj as THREE_NS.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as THREE_NS.Mesh).material as THREE_NS.Material | THREE_NS.Material[] | undefined;
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
