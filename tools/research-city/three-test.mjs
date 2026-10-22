/**
 * vendor three 0.180 实测（node 直接 import，无渲染）：
 * 1) BoxGeometry 顶点/索引数
 * 2) InstancedMesh + setColorAt 在 0.180 是否可用
 * 3) 手工合并 3000 个 box 的耗时与顶点数（模拟 mergeGeometries）
 * 4) 非均匀缩放后法线是否仍归一（applyMatrix4 行为）
 */
import * as THREE from "../../vendor/three/three.module.min.js";
import fs from "node:fs";

console.log("REVISION:", THREE.REVISION);

const box = new THREE.BoxGeometry(1, 1, 1);
console.log("BoxGeometry(1,1,1): verts=", box.attributes.position.count, "index=", box.index.count, "tris=", box.index.count / 3);

const N = 3000;
const t0 = performance.now();
const mesh = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial(), N);
const color = new THREE.Color();
let ok = true;
for (let i = 0; i < N; i += 1) {
  color.setHSL(0.55 + (i / N) * 0.1, 0.3, 0.4 + (i % 7) * 0.04);
  mesh.setColorAt(i, color);
  const m = new THREE.Matrix4().makeTranslation((i % 50) * 2, 0, Math.floor(i / 50) * 2);
  mesh.setMatrixAt(i, m);
}
mesh.instanceMatrix.needsUpdate = true;
if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
console.log(`InstancedMesh ${N} instances + setColorAt: OK (${(performance.now() - t0).toFixed(1)}ms), instanceColor.count=`, mesh.instanceColor ? mesh.instanceColor.count : "null");

const t1 = performance.now();
const parts = [];
for (let i = 0; i < N; i += 1) {
  const g = box.clone();
  g.applyMatrix4(new THREE.Matrix4().makeTranslation((i % 50) * 2, 0, Math.floor(i / 50) * 2));
  parts.push(g);
}
// 手工合并（与 BufferGeometryUtils.mergeGeometries 同思路）
let totalVerts = 0;
let totalIdx = 0;
for (const p of parts) { totalVerts += p.attributes.position.count; totalIdx += p.index.count; }
const positions = new Float32Array(totalVerts * 3);
const normals = new Float32Array(totalVerts * 3);
const uvs = new Float32Array(totalVerts * 2);
const indices = new Uint32Array(totalIdx);
let vo = 0, io = 0, uo = 0, io2 = 0;
for (const p of parts) {
  positions.set(p.attributes.position.array, vo * 3);
  normals.set(p.attributes.normal.array, vo * 3);
  uvs.set(p.attributes.uv.array, uo);
  const idx = p.index.array;
  for (let k = 0; k < idx.length; k += 1) indices[io2 + k] = idx[k] + vo;
  vo += p.attributes.position.count;
  uo += p.attributes.position.count * 2;
  io2 += idx.length;
  io += 1;
  p.dispose();
}
const merged = new THREE.BufferGeometry();
merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
merged.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
merged.setIndex(new THREE.BufferAttribute(indices, 1));
console.log(`merge ${N} boxes: ${(performance.now() - t1).toFixed(1)}ms, verts=${merged.attributes.position.count}, tris=${merged.index.count / 3}, posBuf=${(positions.byteLength / 1024 / 1024).toFixed(2)}MB`);

// 非均匀缩放的矩阵在 instanceMatrix 里直接写：确认 three 侧不重算法线（着色器里 normalMatrix 处理）
const m4 = new THREE.Matrix4().makeScale(0.3, 1.7, 0.22);
mesh.setMatrixAt(0, m4);
const extracted = new THREE.Matrix4();
mesh.getMatrixAt(0, extracted);
console.log("setMatrixAt/getMatrixAt roundtrip OK:", extracted.equals(m4));

// 顶点色方案：merged 上加 color attribute
const vColors = new Float32Array(totalVerts * 3);
merged.setAttribute("color", new THREE.BufferAttribute(vColors, 3));
const vm = new THREE.MeshStandardMaterial({ vertexColors: true });
console.log("vertexColors material created:", vm.vertexColors === true);
