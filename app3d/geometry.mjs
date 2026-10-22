/**
 * 程序化几何工具：河道曲线、沿岸条带、河面带状网格。
 * 只依赖 three 的数学与几何类，不触碰 DOM，因此可在 Node 中直接单测。
 */

import * as THREE from "../vendor/three/three.module.min.js";

/**
 * 由真实河道折线生成平滑曲线。
 * 用 centripetal 参数化：壶城那种发卡弯不会像 uniform 那样过冲自交。
 */
export function curveFromPolyline(points) {
  const vectors = points.map(([x, z]) => new THREE.Vector3(x, 0, z));
  if (vectors.length < 2) {
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(-40, 0, 0),
      new THREE.Vector3(40, 0, 0)
    ]);
  }
  return new THREE.CatmullRomCurve3(vectors, false, "centripetal", 0.5);
}

/**
 * 由桥梁坐标构成一条穿过全部桥梁的平滑曲线，并在两端向外延伸。
 * @param {Array<{x:number, z:number}>} points 世界坐标点（按里程排序）
 * @param {number} extension 两端延伸长度
 */
export function riverCurveFromPoints(points, extension = 26) {
  const vectors = points.map((point) => new THREE.Vector3(point.x, 0, point.z));
  if (vectors.length < 2) {
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(-40, 0, 0),
      new THREE.Vector3(40, 0, 0)
    ]);
  }

  const start = vectors[0].clone();
  const startNext = vectors[1].clone();
  const end = vectors[vectors.length - 1].clone();
  const endPrev = vectors[vectors.length - 2].clone();

  const startDir = start.clone().sub(startNext).normalize();
  const endDir = end.clone().sub(endPrev).normalize();

  const extended = [
    start.clone().addScaledVector(startDir, extension),
    ...vectors,
    end.clone().addScaledVector(endDir, extension)
  ];

  return new THREE.CatmullRomCurve3(extended, false, "catmullrom", 0.4);
}

/** 曲线上距离给定点最近处的参数 t（0–1）。 */
export function nearestT(curve, point, samples = 400) {
  const target = new THREE.Vector3(point.x, 0, point.z);
  let bestT = 0;
  let bestDistance = Infinity;
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const candidate = curve.getPointAt(t);
    const distance = candidate.distanceToSquared(target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestT = t;
    }
  }
  return bestT;
}

/** 曲线在 t 处、与切线垂直的水平单位向量（指向左岸）。 */
export function sideVectorAt(curve, t) {
  const tangent = curve.getTangentAt(t).normalize();
  const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), tangent);
  if (side.lengthSq() < 1e-6) return new THREE.Vector3(1, 0, 0);
  return side.normalize();
}

/**
 * 沿曲线生成一条水平带状网格。
 * @param {THREE.Curve} curve
 * @param {number} innerOffset 内侧相对曲线中线的偏移（正数=左岸方向）
 * @param {number} outerOffset 外侧偏移
 * @param {number} y 高度
 */
export function bandAlongCurve(curve, innerOffset, outerOffset, y = 0, segments = 140) {
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const point = curve.getPointAt(t);
    const side = sideVectorAt(curve, t);
    const inner = point.clone().addScaledVector(side, innerOffset);
    const outer = point.clone().addScaledVector(side, outerOffset);
    positions.push(inner.x, y, inner.z, outer.x, y, outer.z);
    uvs.push(0, t * 8, 1, t * 8);
  }

  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** 河面：以中线对称的一条带状网格。 */
export function riverSurface(curve, halfWidth, y = 0.05, segments = 140) {
  const geometry = bandAlongCurve(curve, halfWidth, -halfWidth, y, segments);
  // 该带的顶点顺序左右相反，翻转索引朝向以保证法线朝上。
  const index = geometry.getIndex();
  if (index) {
    const array = index.array;
    for (let i = 0; i < array.length; i += 3) {
      const tmp = array[i];
      array[i] = array[i + 1];
      array[i + 1] = tmp;
    }
    index.needsUpdate = true;
    geometry.computeVertexNormals();
  }
  return geometry;
}

/** 抛物线拱肋的曲线，位于 XY 平面。 */
export function archCurve(span, baseY, rise, segments = 24) {
  const points = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const x = (t - 0.5) * span;
    const y = baseY + rise * (1 - Math.pow((2 * x) / span, 2));
    points.push(new THREE.Vector3(x, y, 0));
  }
  return new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
}

/** 四棱锥屋顶（正四棱锥，绕 Y 旋转 45° 后与轴对齐）。 */
export function pyramidRoof(width, height, depth = width) {
  const geometry = new THREE.ConeGeometry(Math.max(width, depth) * 0.72, height, 4, 1);
  geometry.rotateY(Math.PI / 4);
  geometry.scale(width / Math.max(width, depth), 1, depth / Math.max(width, depth));
  return geometry;
}

export { THREE };
