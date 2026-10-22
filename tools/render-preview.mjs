/**
 * 软件光栅预览：不经 WebGL，把场景里的某个对象渲成 PNG。
 *
 * 沙箱里跑不起 Chromium（命名管道受限），所以"看起来对不对"没法靠截图确认。
 * 这个工具用 Node 的 zlib 手写 PNG，做一个带 z 缓冲的三角形光栅器，
 * 只渲几何 + 平面着色——足够判断轮廓、比例、遮挡关系这些结构问题。
 *
 *   node tools/render-preview.mjs wenhui
 *   node tools/render-preview.mjs wenhui --perspective
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as THREE from "../vendor/three/three.module.min.js";
import { buildAtlas } from "../app3d/atlas.mjs";

/* ---------------- PNG ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------------- 光栅器 ---------------- */

const LIGHT = new THREE.Vector3(-0.42, 0.78, 0.46).normalize();

function rasterize({ triangles, width, height, project, background, ambient = 0.34 }) {
  const color = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    color[i * 3] = background[0];
    color[i * 3 + 1] = background[1];
    color[i * 3 + 2] = background[2];
  }
  const depth = new Float32Array(width * height).fill(Infinity);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (const triangle of triangles) {
    a.fromArray(triangle.a);
    b.fromArray(triangle.b);
    c.fromArray(triangle.c);

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac).normalize();
    const shade = ambient + (1 - ambient) * Math.abs(normal.dot(LIGHT));
    const r = Math.min(255, Math.round(triangle.color[0] * shade));
    const g = Math.min(255, Math.round(triangle.color[1] * shade));
    const blue = Math.min(255, Math.round(triangle.color[2] * shade));

    const pa = project(a);
    const pb = project(b);
    const pc = project(c);

    const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
    const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
    if (maxX < minX || maxY < minY) continue;

    const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
    if (Math.abs(area) < 1e-9) continue;
    const inverseArea = 1 / area;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((pb[0] - px) * (pc[1] - py) - (pc[0] - px) * (pb[1] - py)) * inverseArea;
        const w1 = ((pc[0] - px) * (pa[1] - py) - (pa[0] - px) * (pc[1] - py)) * inverseArea;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const z = pa[2] * w0 + pb[2] * w1 + pc[2] * w2;
        const index = y * width + x;
        if (z >= depth[index]) continue;
        depth[index] = z;
        color[index * 3] = r;
        color[index * 3 + 1] = g;
        color[index * 3 + 2] = blue;
      }
    }
  }
  return color;
}

/* ---------------- 取几何 ---------------- */

function collectTriangles(root, colorOf) {
  const triangles = [];
  root.updateMatrixWorld(true);

  // 用 root 的局部坐标：桥在世界里是斜的，正立面必须沿桥轴看，
  // 否则"侧视图"其实是斜视图，长度被压掉一大半。
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const matrix = new THREE.Matrix4();

  root.traverse((object) => {
    if (!object.isMesh || object.isInstancedMesh) return;
    // 拾取代理关掉了 material.visible，光标记是半透明贴花：都不参与成型
    if (object.material && (object.material.visible === false || object.material.transparent)) return;

    matrix.multiplyMatrices(toLocal, object.matrixWorld);
    const geometry = object.geometry;
    const position = geometry.attributes.position;
    const index = geometry.index;
    const color = colorOf(object.material);
    const count = index ? index.count : position.count;

    const vertex = (i) => {
      const vector = new THREE.Vector3();
      if (index) vector.fromBufferAttribute(position, index.getX(i));
      else vector.fromBufferAttribute(position, i);
      return vector.applyMatrix4(matrix).toArray();
    };

    for (let i = 0; i < count; i += 3) {
      triangles.push({ a: vertex(i), b: vertex(i + 1), c: vertex(i + 2), color });
    }
  });
  return triangles;
}
/* ---------------- 主流程 ---------------- */

const id = process.argv[2] || "wenhui";
const perspective = process.argv.includes("--perspective");

const atlas = buildAtlas();
const entry = atlas.bridges.get(id);
if (!entry) {
  console.error("找不到桥:", id);
  process.exit(1);
}

const colorOf = (material) => {
  const hex = material.color || new THREE.Color("#cccccc");
  return [hex.r * 255, hex.g * 255, hex.b * 255];
};

const triangles = collectTriangles(entry.group, colorOf);

// 世界包围盒 → 取景
const box = new THREE.Box3();
for (const triangle of triangles) {
  for (const point of [triangle.a, triangle.b, triangle.c]) {
    box.expandByPoint(new THREE.Vector3().fromArray(point));
  }
}
const center = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());

const width = 1400;
const margin = 0.05;
// 正立面按桥的长高比定画幅高度，否则 6:1 的桥挤在 1400×620 里只占三分之一高
const height = perspective
  ? 820
  : Math.round(Math.min(760, Math.max(220, (width * (1 - margin * 2) * size.y) / size.x + 56)));

let project;
if (perspective) {
  const direction = new THREE.Vector3(0.55, 0.34, 0.76).normalize();
  const focal = (height * (1 - margin * 2)) / (2 * Math.tan((38 * Math.PI) / 360));
  let distance = size.length() * 1.2;
  let projectAt = null;

  const buildProjection = (eyeDistance) => {
    const eye = center.clone().addScaledVector(direction, eyeDistance);
    const forward = new THREE.Vector3().subVectors(center, eye).normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    return (point) => {
      const relative = new THREE.Vector3().subVectors(point, eye);
      const depth = relative.dot(forward);
      if (depth <= 0.01) return [-1e6, -1e6, 1e9];
      return [
        width / 2 + (relative.dot(right) / depth) * focal,
        height / 2 - (relative.dot(up) / depth) * focal,
        depth
      ];
    };
  };

  // 迭代三次把机位推远/拉近到画面填充约 92%
  const vertices = [];
  for (const triangle of triangles) {
    vertices.push(triangle.a, triangle.b, triangle.c);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    projectAt = buildProjection(distance);
    let minPx = Infinity;
    let maxPx = -Infinity;
    let minPy = Infinity;
    let maxPy = -Infinity;
    for (const vertex of vertices) {
      const point = new THREE.Vector3().fromArray(vertex);
      const [px, py] = projectAt(point);
      if (px < minPx) minPx = px;
      if (px > maxPx) maxPx = px;
      if (py < minPy) minPy = py;
      if (py > maxPy) maxPy = py;
    }
    // 透视下主体不居中，要按"离画面中心最远的那条边"来拟合，否则会有一侧出框
    const halfWidth = Math.max(maxPx - width / 2, width / 2 - minPx);
    const halfHeight = Math.max(maxPy - height / 2, height / 2 - minPy);
    const fill = Math.max(halfWidth / (width / 2), halfHeight / (height / 2));
    distance *= Math.max(0.55, Math.min(1.8, fill / 0.92));
  }
  project = buildProjection(distance); // 用最后一次调整后的机位重建，否则投影落后一步
} else {
  // 正立面：沿 -z 看，只按 x/y 投影
  const scale = Math.min((width * (1 - margin * 2)) / size.x, (height * (1 - margin * 2)) / size.y);
  project = (point) => [
    width / 2 + (point.x - center.x) * scale,
    height / 2 - (point.y - center.y) * scale,
    -point.z
  ];
}

const background = perspective ? [214, 232, 240] : [246, 248, 247];
const rgb = rasterize({ triangles, width, height, project, background });

/* 自检：暗像素的外接框应当与几何投影框吻合，否则是光栅器的问题而不是模型的问题 */
{
  const bgLum = background[0] * 0.299 + background[1] * 0.587 + background[2] * 0.114;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const lum = rgb[index] * 0.299 + rgb[index + 1] * 0.587 + rgb[index + 2] * 0.114;
      if (lum < bgLum - 14) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  console.log(`暗像素外接框 x ${minX}..${maxX}  y ${minY}..${maxY}`);
}

/* 终端里先看一眼：降采样成字符画，背景是浅色、结构是深色 */
if (process.argv.includes("--ascii")) {
  const cols = Number(process.env.PREVIEW_COLS || 152);
  const rows = Number(process.env.PREVIEW_ROWS || 44);
  const ramp = " .:-=+*#%@";
  let out = "";
  for (let row = 0; row < rows; row += 1) {
    let line = "";
    for (let col = 0; col < cols; col += 1) {
      const x = Math.min(width - 1, Math.floor(((col + 0.5) / cols) * width));
      const y = Math.min(height - 1, Math.floor(((row + 0.5) / rows) * height));
      const index = (y * width + x) * 3;
      const lum = (rgb[index] * 0.299 + rgb[index + 1] * 0.587 + rgb[index + 2] * 0.114) / 255;
      const darkness = Math.min(1, Math.max(0, (0.97 - lum) * 7));
      line += ramp[Math.min(ramp.length - 1, Math.floor(darkness * ramp.length))];
    }
    out += `${line}\n`;
  }
  if (process.env.PREVIEW_OUT) fs.writeFileSync(process.env.PREVIEW_OUT, out, "utf8"); else console.log(out);
}

const png = encodePng(width, height, rgb);
const outFile = path.resolve("preview", `${id}${perspective ? "-persp" : "-elev"}.png`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, png);
console.log(`写出 ${outFile}  ${width}×${height}  ${(png.length / 1024).toFixed(0)} KB  ${triangles.length} 三角形`);
