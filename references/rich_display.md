# Rich Display & SVG Templates

## Rich HTML / 3D Display (MANDATORY)

HiyoCanvasはノードの実行結果として`display(HTML(...))`で出力されたHTMLを**sandboxed iframe**内で表示する。JavaScript・WebGLが動作するため、3Dビューアやインタラクティブなビジュアライゼーションが可能。

### 必須ルール

**以下のルールはCadQuery、PyVista、trimesh、Open3D、plotly等すべてのリッチHTML表示に適用される。違反するとタイムアウトや表示不能になる。**

1. **`display(HTML(html_string))`で自己完結HTMLを出力する**
   - iframe内で動作するため、HTMLは`<script>`タグを含む完全なドキュメントでよい
   - 外部CDN（three.js等）の読み込みも可能

2. **3Dライブラリ（CadQuery等）ではファイルI/Oを使わない**
   - `export()`, `save()`, `to_file()`等でSTL/OBJを書き出してから読み戻す方式は禁止
   - 代わりに`tessellate()`等のAPI で頂点・面データをメモリ上で取得し、JSONでHTMLに埋め込む

3. **ブーリアン演算（union/cut/intersect）を避ける**
   - OCCTのブーリアン演算は複数パーツで数秒〜数十秒かかる
   - 代わりにパーツごとに個別に`tessellate()`し、頂点・面リストを結合する
   - 見た目は同じで10倍以上高速

### CadQuery 3D表示テンプレート

```python
import cadquery as cq
import json
from IPython.display import display, HTML

# --- モデル作成 ---
parts = []
parts.append(cq.Workplane("XY").box(10, 20, 5).edges(">Z").fillet(1))
parts.append(cq.Workplane("XY").cylinder(8, 3).translate((0, 0, 10)))

# --- パーツ別tessellate（union不要）---
all_verts, all_faces, offset = [], [], 0
for p in parts:
    v, f = p.val().tessellate(0.1)
    all_verts.extend([[vi.x, vi.y, vi.z] for vi in v])
    all_faces.extend([[fi[0]+offset, fi[1]+offset, fi[2]+offset] for fi in f])
    offset += len(v)

# --- three.js HTML ---
html = f"""
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<canvas id="c" style="width:100%;height:400px;display:block"></canvas>
<script>
const verts = {json.dumps(all_verts)};
const faces = {json.dumps(all_faces)};
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({{canvas, antialias: true}});
renderer.setSize(canvas.clientWidth, 400);
renderer.setClearColor(0x1a1a2e);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth/400, 0.1, 1000);
const geom = new THREE.BufferGeometry();
const positions = new Float32Array(faces.length * 9);
for (let i = 0; i < faces.length; i++) {{
  for (let j = 0; j < 3; j++) {{
    positions[i*9+j*3]   = verts[faces[i][j]][0];
    positions[i*9+j*3+1] = verts[faces[i][j]][1];
    positions[i*9+j*3+2] = verts[faces[i][j]][2];
  }}
}}
geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geom.computeVertexNormals();
const mesh = new THREE.Mesh(geom, new THREE.MeshPhongMaterial({{
  color: 0x4fc3f7, specular: 0x444444, shininess: 30, side: THREE.DoubleSide
}}));
scene.add(mesh);
scene.add(new THREE.AmbientLight(0x606060));
const dl = new THREE.DirectionalLight(0xffffff, 0.7);
dl.position.set(10, 20, 15); scene.add(dl);
geom.computeBoundingSphere();
const r = geom.boundingSphere.radius, ctr = geom.boundingSphere.center;
camera.position.set(ctr.x+r*2, ctr.y+r*1.5, ctr.z+r*2);
camera.lookAt(ctr);
// Orbit controls
let isDragging=false, prev={{x:0,y:0}};
let sph={{r:camera.position.distanceTo(ctr), theta:Math.PI/4, phi:Math.PI/4}};
const tgt=ctr.clone();
function updateCam(){{
  camera.position.set(tgt.x+sph.r*Math.sin(sph.phi)*Math.cos(sph.theta),
    tgt.y+sph.r*Math.cos(sph.phi),
    tgt.z+sph.r*Math.sin(sph.phi)*Math.sin(sph.theta));
  camera.lookAt(tgt);
}}
canvas.addEventListener('pointerdown',e=>{{isDragging=true;prev={{x:e.clientX,y:e.clientY}};}});
canvas.addEventListener('pointerup',()=>{{isDragging=false;}});
canvas.addEventListener('pointermove',e=>{{
  if(!isDragging)return;
  sph.theta+=(e.clientX-prev.x)*0.01;
  sph.phi=Math.max(0.1,Math.min(Math.PI-0.1,sph.phi-(e.clientY-prev.y)*0.01));
  prev={{x:e.clientX,y:e.clientY}};updateCam();
}});
canvas.addEventListener('wheel',e=>{{sph.r*=e.deltaY>0?1.1:0.9;updateCam();}});
function animate(){{requestAnimationFrame(animate);renderer.render(scene,camera);}}
animate();
new ResizeObserver(()=>{{
  window.parent.postMessage({{type:'iframe-resize',height:420}},'*');
}}).observe(document.body);
</script>
"""
display(HTML(html))
```

### SDF 3D Display (sdfcad)

SDF（Signed Distance Function）ライブラリ`sdfcad`を使った3Dモデリング。CadQueryと異なり純Python + NumPyで動作し、ブーリアン演算が常に成功する。

**パッケージ:** `pip install sdfcad` （インポートは `from sdf import *`）

**CadQueryとの違い:**
- `generate(step=...)` は**フラットな三角形スープ**（N*3 × 3 配列）を返す — 頂点/面の分離なし
- JavaScript側は `Float32Array` に直接変換可能（面インデックスの展開ループ不要）
- ブーリアン演算（`&`, `|`, `-`）は常に高速・安定（min/max演算のため）

```python
from sdf import *
import numpy as np
import json
from IPython.display import display, HTML

def sdf_show(shape, step=0.05, color=0x4fc3f7, bg=0x1a1a2e):
    """Generate mesh from SDF shape and display interactive 3D viewer."""
    pts = np.array(shape.generate(step=step))
    n_tris = len(pts) // 3
    positions = [round(v, 5) for v in pts.flatten().tolist()]
    html = f"""
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<canvas id="c" style="width:100%;height:400px;display:block"></canvas>
<script>
const positions = {json.dumps(positions)};
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({{canvas, antialias: true}});
renderer.setSize(canvas.clientWidth, 400);
renderer.setClearColor({bg});
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth/400, 0.1, 1000);
const geom = new THREE.BufferGeometry();
// SDF returns flat triangle soup — no face index dereferencing needed
const pos = new Float32Array(positions);
geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geom.computeVertexNormals();
const mesh = new THREE.Mesh(geom, new THREE.MeshPhongMaterial({{
  color: {color}, specular: 0x444444, shininess: 30, side: THREE.DoubleSide
}}));
scene.add(mesh);
scene.add(new THREE.AmbientLight(0x606060));
const dl = new THREE.DirectionalLight(0xffffff, 0.7);
dl.position.set(10, 20, 15); scene.add(dl);
geom.computeBoundingSphere();
const r = geom.boundingSphere.radius, ctr = geom.boundingSphere.center;
camera.position.set(ctr.x+r*2, ctr.y+r*1.5, ctr.z+r*2);
camera.lookAt(ctr);
// ... orbit controls (same as CadQuery template) ...
</script>
"""
    display(HTML(html))

# --- Example: sphere with cylinder holes ---
f = sphere(1) & box(1.5)
c = cylinder(0.5)
f -= c.orient(X) | c.orient(Y) | c.orient(Z)
sdf_show(f, step=0.05)
```

**step値の目安:**
| step | 三角形数（典型） | 時間 | 用途 |
|------|-----------------|------|------|
| 0.1 | 1k-5k | <1s | プレビュー |
| 0.05 | 10k-50k | 1-5s | デフォルト（バランス良） |
| 0.025 | 50k-200k | 5-30s | 高品質 |
| 0.01 | 500k+ | 数分 | 最高品質（タイムアウト注意） |

### VRM/GLTFアバター・3Dモデル表示

ワークスペースフォルダに配置した`.vrm`/`.glb`ファイルをthree.js + GLTFLoaderで表示できる。
ファイルはFastAPIが `/workspaces/` 配下で静的配信する（レガシーフォルダ構造のみ）。

```python
from IPython.display import display, HTML

# ワークスペースフォルダ内のモデルファイルURL
model_url = 'http://127.0.0.1:18731/workspaces/<workspace_folder>/model.vrm'

html = f"""
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>
<canvas id="c" style="width:100%;height:500px;display:block"></canvas>
<div id="info" style="color:#aaa;font-size:12px;margin-top:4px">Loading...</div>
<script>
const canvas = document.getElementById('c');
const info = document.getElementById('info');
const renderer = new THREE.WebGLRenderer({{canvas, antialias: true}});
renderer.setSize(canvas.clientWidth, 500);
renderer.setClearColor(0x1a1a2e);
renderer.outputEncoding = THREE.sRGBEncoding;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, canvas.clientWidth/500, 0.1, 100);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dl = new THREE.DirectionalLight(0xffffff, 0.8);
dl.position.set(2, 3, 4); scene.add(dl);

new THREE.GLTFLoader().load('{model_url}', function(gltf) {{
  const model = gltf.scene;
  scene.add(model);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  model.position.y += size.y / 2;
  const dist = size.y * 1.8;
  camera.position.set(0, size.y*0.5, dist);
  camera.lookAt(0, size.y*0.45, 0);
  info.textContent = 'Loaded (' + size.y.toFixed(2) + 'm). Drag to rotate, scroll to zoom.';
  // Orbit
  let isDragging=false, prev={{x:0,y:0}};
  let theta=0, phi=Math.PI/2.2, radius=dist;
  const tgt = new THREE.Vector3(0, size.y*0.45, 0);
  function updateCam() {{
    camera.position.set(tgt.x+radius*Math.sin(phi)*Math.sin(theta),
      tgt.y+radius*Math.cos(phi), tgt.z+radius*Math.sin(phi)*Math.cos(theta));
    camera.lookAt(tgt);
  }}
  canvas.addEventListener('pointerdown',e=>{{isDragging=true;prev={{x:e.clientX,y:e.clientY}};}});
  canvas.addEventListener('pointerup',()=>{{isDragging=false;}});
  canvas.addEventListener('pointermove',e=>{{
    if(!isDragging)return;
    theta+=(e.clientX-prev.x)*0.01;
    phi=Math.max(0.1,Math.min(Math.PI-0.1,phi-(e.clientY-prev.y)*0.01));
    prev={{x:e.clientX,y:e.clientY}};updateCam();
  }});
  canvas.addEventListener('wheel',e=>{{radius*=e.deltaY>0?1.1:0.9;updateCam();}});
}}, xhr => {{
  info.textContent = 'Loading: ' + Math.round(xhr.loaded/xhr.total*100) + '%';
}}, err => {{
  info.textContent = 'Error: ' + err.message;
}});

function animate() {{ requestAnimationFrame(animate); renderer.render(scene, camera); }}
animate();
new ResizeObserver(() => {{
  window.parent.postMessage({{type:'iframe-resize',height:530}},'*');
}}).observe(document.body);
</script>
"""
display(HTML(html))
```

**注意:**
- モデルファイルは`workspaces/`配下に配置する（レガシーフォルダ構造を使用）
- VRM/GLB両対応（GLTFLoaderが両方読める）

### 他のライブラリでの応用

- **trimesh**: `mesh.vertices.tolist()`, `mesh.faces.tolist()` → 同じthree.jsテンプレート
- **PyVista**: `mesh.points.tolist()`, `mesh.faces.reshape(-1,4)[:,1:].tolist()` → 同上
- **plotly**: `fig.to_html(include_plotlyjs='cdn', full_html=True)` → `display(HTML(html))`で直接表示可能
- **Open3D**: `mesh.vertices`, `mesh.triangles` をnumpy→list変換 → 同じthree.jsテンプレート

## SVG Display

Nodes can render inline SVG graphics. Use for diagrams, illustrations, data visualizations, icons, etc.

### Basic Pattern
```python
from IPython.display import display, SVG

svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
  <rect x="10" y="10" width="280" height="180" rx="10" fill="#1a1a2e" stroke="#4fc3f7"/>
  <text x="150" y="105" text-anchor="middle" fill="#e2e8f0" font-size="16">Hello SVG</text>
</svg>'''
display(SVG(svg))
```

### Rules
1. Use `display(SVG(svg_string))` — not `display(HTML(...))`
2. SVG must be valid self-contained XML (xmlns attribute required)
3. Match dark theme: background `#1a1a2e`, text `#e2e8f0`, accent `#4fc3f7`
4. Set width/height to control size (recommend 300px or less to fit node width)
5. Use cases: flowcharts, concept diagrams, data visualizations, icons, explanatory figures
6. **Always use `code_file` for SVG code** (Key Rule #10). SVG contains quotes, `<>`, `/` etc. that break shell argument parsing. Write code to a temp file, then pass the path
