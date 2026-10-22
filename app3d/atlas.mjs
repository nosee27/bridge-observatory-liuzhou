/**
 * 城市总览场景（真实地理版）。
 *
 * 几何全部来自 app3d/geo.mjs（由 tools/build-geo.mjs 从 OpenStreetMap 生成）：
 *   - 河道：真实中心线折线（1 世界单位 = 100 米）
 *   - 桥梁：真实中心点、真实轴向角、真实桥长/桥宽
 *
 * 两条刻意的取舍，写在明处：
 *   1) 竖向夸张 2.2 倍——真实桥在 10 km 视野里薄如纸片，抬高结构件只为可读；
 *      平面尺寸（长度、宽度、位置、朝向）不做夸张。
 *   2) 最小尺寸地板——桥面宽度不足 34 m 的按 34 m 画，否则在总览里根本看不见。
 */

import * as THREE from "../vendor/three/three.module.min.js";
import { BRIDGES } from "./data.mjs";
import { GEO } from "./geo.mjs";
import { TERRAIN } from "./terrain.mjs";
import { getTheme } from "./theme.mjs";
import {
  riverSurface,
  archCurve,
  pyramidRoof,
  curveFromPolyline
} from "./geometry.mjs";

const VERTICAL = 2.2;
/**
 * 建筑与江岸之间留出的空地（世界单位，1 单位 = 100 米）。
 * 沙滩层已经去掉，这个值现在只用来约束两栋场馆不要贴着水边。
 */
const RIVER_CLEARANCE = 5;
/**
 * 地面向外铺多远。镜头可以自由转到任意一侧，最远拉到 420 单位，
 * 地面边缘必须落到雾的尽头之外（雾 320–1300）才不会露出硬边。
 */
const GROUND_MARGIN = 1700;

const MIN_BRIDGE_LENGTH = 2.2;
const MIN_BRIDGE_WIDTH = 0.2;

/**
 * 所有几何的基座都在 y = 0（桥墩、场馆都是从 0 往上长），
 * 所以地面必须也在 0，否则所有东西都会悬空——之前地面在 -0.06，
 * 等于全场景离地 6 米，近距离一看就是一片浮在半空的模型。
 */
const GROUND_Y = 0;

/**
 * 水面**不是**放在地面之下：地面是一整张连续平面，
 * 低于它的水会被它盖住，什么也看不见（要看见就必须在地面上挖洞）。
 * 所以水面与地面同高，靠 polygonOffset 稳定压在地面之上当贴花用——
 * 偏移量按深度分辨率自适应，任何视距都不会失效，比抬高几何稳得多。
 * 保留 0.004 的几何微抬（0.4 米），让近景也不至于输给地面。
 */
const WATER_Y = 0.004;

/** 桥墩向下埋入的深度：保证桥被选中抬起 0.12 时，墩底仍在水面之下看不见。 */
const PIER_BASE = -0.25;

/**
 * 主题里只有纯数据；这里按传入的主题现算材质色。
 *
 * 早先是模块级常量；改成参数后，测试与将来的配色实验可以换主题构建，
 * 不必重新 import 模块。
 */
const toHex = (value) => new THREE.Color(value).getHex();

function buildPalette(theme) {
  return Object.fromEntries(
    Object.entries(theme.materials).map(([key, value]) => [key, toHex(value)])
  );
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/**
 * 地形网格：喀斯特孤峰平原。
 *
 * 数据来自 tools/build-dem.mjs（DEM 重采样后压平成 Uint16 相对高程），
 * 这里解码、竖放、按"高度 + 坡度"上色，并把网格挂进 root。
 *
 * 返回双线性与三角面两个高度查询函数：场馆必须按地形高度落座，
 * 道路必须贴三角面（双线性在陡坡上与真实面最大差 0.24 单位）。
 */
function createTerrain(root, theme) {
  const { cols, rows, step, minX, minZ, maxX, maxZ, unitMeters } = TERRAIN;
  const exaggeration = theme.terrain.exaggeration;

  // base64 → Uint16（小端）
  const binary = atob(TERRAIN.data);
  const count = cols * rows;
  const quantized = new Uint16Array(count);
  for (let i = 0; i < count; i += 1) {
    quantized[i] = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
  }

  // 存储值 = 相对高程 × 10（米），渲染高度再乘竖向夸张并换算成世界单位
  const toUnits = (value) => (value / 10) * (exaggeration / unitMeters);

  /*
   * 所有高度运算只读这一份 Float32 网格：削山之后，网格顶点、heightAt、
   * surfaceHeightAt 三者必须看到同一组高度，否则路面又会浮空或陷地。
   */
  const grid = new Float32Array(count);
  for (let i = 0; i < count; i += 1) grid[i] = toUnits(quantized[i]);
  const naturalGrid = Float32Array.from(grid);

  const gridHeight = (c, r) => {
    const cc = Math.min(cols - 1, Math.max(0, c));
    const rr = Math.min(rows - 1, Math.max(0, r));
    return grid[rr * cols + cc];
  };

  /** 双线性高度查询（世界坐标，单位）。 */
  const heightAt = (x, z) => {
    const fx = (x - minX) / step;
    const fz = (z - minZ) / step;
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fz);
    const ax = fx - c0;
    const az = fz - r0;
    const h00 = gridHeight(c0, r0);
    const h10 = gridHeight(c0 + 1, r0);
    const h01 = gridHeight(c0, r0 + 1);
    const h11 = gridHeight(c0 + 1, r0 + 1);
    return (h00 * (1 - ax) + h10 * ax) * (1 - az) + (h01 * (1 - ax) + h11 * ax) * az;
  };

  /**
   * 地形**三角面**高度（世界坐标）。与 heightAt 的双线性不同，这个函数精确落在
   * 网格三角形的平面上——贴地物（道路）必须用它，否则在起伏处会一半陷入地里、
   * 一半浮在空中，又回到"贴花浮空"的老问题上。
   *
   * PlaneGeometry 每格沿 (列,行) 的对角线 b–d 切分，即 (c0,r0+1)→(c0+1,r0)：
   *   u + v <= 1 用三角形 a(0,0) b(1,0) ... 实际顶点为 (0,0)/(1,0)/(0,1)
   *   u + v >= 1 用另一片
   */
  const surfaceHeightAt = (x, z) => {
    let fx = (x - minX) / step;
    let fz = (z - minZ) / step;
    const c0 = Math.min(cols - 2, Math.max(0, Math.floor(fx)));
    const r0 = Math.min(rows - 2, Math.max(0, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - c0));
    const v = Math.min(1, Math.max(0, fz - r0));

    const h00 = gridHeight(c0, r0);
    const h10 = gridHeight(c0 + 1, r0);
    const h01 = gridHeight(c0, r0 + 1);
    const h11 = gridHeight(c0 + 1, r0 + 1);

    if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
    return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  };

  const width = maxX - minX;
  const depth = maxZ - minZ;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;

  const geometry = new THREE.PlaneGeometry(width, depth, cols - 1, rows - 1);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);

  const basin = new THREE.Color(theme.terrain.basin);
  const slopeColor = new THREE.Color(theme.terrain.slope);
  const rock = new THREE.Color(theme.terrain.rock);
  const ridge = new THREE.Color(theme.terrain.ridge);
  const scratch = new THREE.Color();

  for (let i = 0; i < position.count; i += 1) {
    const localX = position.getX(i);
    const localZ = position.getZ(i);
    const worldX = localX + centerX;
    const worldZ = localZ + centerZ;

    const height = heightAt(worldX, worldZ);
    position.setY(i, height);

    // 坡度：用同一套高度查询取中心差分，避免再存一份邻接表
    const dhx = (heightAt(worldX + step, worldZ) - heightAt(worldX - step, worldZ)) / (2 * step);
    const dhz = (heightAt(worldX, worldZ + step) - heightAt(worldX, worldZ - step)) / (2 * step);
    const slope = Math.hypot(dhx, dhz);

    // 上色：先按高度从盆底绿过渡到坡面绿，再按坡度露出灰岩，峰顶压深
    const vegetation = Math.min(1, height / 0.5);
    const bareRock = smoothstep((slope - 0.55) / 0.75);
    const crest = smoothstep((height - 1.9) / 1.8);

    scratch.copy(basin).lerp(slopeColor, vegetation).lerp(rock, bareRock * 0.85);
    scratch.lerp(ridge, crest * (1 - bareRock) * 0.55);

    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    name: "terrain",
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
    metalness: 0
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(centerX, 0, centerZ);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);

  return { heightAt, surfaceHeightAt };
}

/** 与 three 的 smoothstep 同义，这里自己写一份以免依赖工具函数。 */
function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function box(width, height, depth, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  return mesh;
}

function cylinder(radius, height, material, x = 0, y = 0, z = 0, segments = 8) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, segments), material);
  mesh.position.set(x, y, z);
  return mesh;
}

function rodBetween(start, end, radius, material) {
  const direction = new THREE.Vector3().subVectors(end, start);
  const geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), 5);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(start).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
  return mesh;
}

/** 确定性伪随机。当前无调用方（占位街区 v2.4 已移除），保留给后续可复现的点缀物（路灯、车流）。 */
function createRandom(seed = 20261020) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/** 点到折线的最短距离（世界单位）。 */
function distanceToPolyline(px, pz, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    const [ax, az] = line[i - 1];
    const [bx, bz] = line[i];
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const distance = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
    if (distance < best) best = distance;
  }
  return best;
}

function distanceToRivers(px, pz, rivers) {
  let best = Infinity;
  for (const line of rivers) {
    const distance = distanceToPolyline(px, pz, line);
    if (distance < best) best = distance;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * 零件合并：把一座桥烧成 3–4 个网格
 * ------------------------------------------------------------------ */

/**
 * 合并一组已烘焙变换的几何体。
 *
 * 文惠桥是五孔连拱：8 片拱肋、几十根吊杆、横撑和立柱。每个零件一个 Mesh
 * 就是上百次 draw call；按材质烧成一个网格后，整座桥只剩
 * "钢管 / 混凝土 / 桥面 / 栏杆" 四个 draw call。
 */
function mergeGeometries(geometries) {
  const positions = [];
  const normals = [];
  const indices = [];
  let offset = 0;

  for (const geometry of geometries) {
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      if (normal) normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    }
    const index = geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + offset);
    } else {
      for (let i = 0; i < position.count; i += 1) indices.push(i + offset);
    }
    offset += position.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  // 两个数组存的都是"浮点数个数"，比例是 1:1。原先写成 normals.length*3 === positions.length，
  // 相当于要求顶点数为零，于是法线永远不写进合并后的几何体：
  // 着色器拿到的 objectNormal 是缺省属性 (0,0,0)，normalize 后是 NaN，整座桥渲成纯黑。
  if (normals.length === positions.length) {
    merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  }
  merged.setIndex(indices);
  return merged;
}

/**
 * 零件收集器：add 系列方法把几何体连变换一起烘焙进去，finish() 按材质合并输出。
 * 变换在收集时烘焙，合并阶段就不再需要矩阵。
 */
function createPartBuilder() {
  const parts = [];
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const direction = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  // 构件身份：建模时用 beginPart("deck", "桥面") 打标，
  // finish() 按 (构件, 材质) 分组出网格——这样拾取能精确到"拱肋/吊索/桥墩"，
  // 而不是整座桥一个网格。
  let currentPart = { id: "body", label: "整体" };

  const beginPart = (id, label) => {
    currentPart = { id, label: label || id };
  };

  const push = (geometry, material) => {
    geometry.applyMatrix4(matrix);
    parts.push({
      geometry,
      material,
      partId: currentPart.id,
      partLabel: currentPart.label
    });
  };

  /** 轴对齐（可带旋转）的盒子。 */
  const box = (width, height, depth, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    euler.set(rx, ry, rz);
    quaternion.setFromEuler(euler);
    position.set(x, y, z);
    scale.set(1, 1, 1);
    matrix.compose(position, quaternion, scale);
    push(new THREE.BoxGeometry(width, height, depth), material);
  };

  /** 两点之间的圆柱（吊杆、立柱、斜撑）。 */
  const rod = (from, to, radius, material, radial = 5) => {
    direction.subVectors(to, from);
    const length = direction.length();
    if (length < 1e-6) return;
    direction.normalize();
    quaternion.setFromUnitVectors(up, direction);
    position.addVectors(from, to).multiplyScalar(0.5);
    scale.set(1, length, 1);
    matrix.compose(position, quaternion, scale);
    push(new THREE.CylinderGeometry(radius, radius, 1, radial), material);
  };

  /** 沿曲线的圆管（拱肋）。 */
  const tube = (curve, radius, material, radialSegments = 6, segments = 40, z = 0) => {
    position.set(0, 0, z);
    quaternion.identity();
    scale.set(1, 1, 1);
    matrix.compose(position, quaternion, scale);
    push(new THREE.TubeGeometry(curve, segments, radius, radialSegments, false), material);
  };

  /** 圆台 / 圆锥：八角亭的檐、塔身、宝顶都用它。radial = 8 就是八边形。 */
  const cone = (radiusTop, radiusBottom, height, radial, material, x = 0, y = 0, z = 0, ry = 0) => {
    euler.set(0, ry, 0);
    quaternion.setFromEuler(euler);
    position.set(x, y, z);
    scale.set(1, 1, 1);
    matrix.compose(position, quaternion, scale);
    push(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radial), material);
  };

  /** 现成的屋面几何体（歇山亭的四坡顶）。 */
  const shape = (geometry, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    euler.set(rx, ry, rz);
    quaternion.setFromEuler(euler);
    position.set(x, y, z);
    scale.set(1, 1, 1);
    matrix.compose(position, quaternion, scale);
    push(geometry, material);
  };

  const finish = () => {
    const group = new THREE.Group();
    const byKey = new Map();
    for (const part of parts) {
      const key = `${part.partId}\u0000${part.material.uuid}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          partId: part.partId,
          partLabel: part.partLabel,
          material: part.material,
          geometries: []
        });
      }
      byKey.get(key).geometries.push(part.geometry);
    }

    const partsById = new Map();
    for (const bucket of byKey.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(bucket.geometries), bucket.material);
      // 不投影也不接收阴影：与另外四座桥保持一致。
      // 拱肋半径只有 0.025，而阴影贴图纹理素约 0.04、normalBias 又是 0.06——
      // 薄构件落在这种精度下只会得到自阴影噪点，不如干脆不参与阴影。
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.partId = bucket.partId;
      group.add(mesh);

      if (!partsById.has(bucket.partId)) {
        partsById.set(bucket.partId, {
          id: bucket.partId,
          label: bucket.partLabel,
          meshes: []
        });
      }
      partsById.get(bucket.partId).meshes.push(mesh);
    }

    group.userData.parts = partsById;
    return group;
  };

  return { box, rod, tube, cone, shape, beginPart, finish, count: () => parts.length };
}

/**
 * 在拱平面（XY）内把曲线沿法向偏移。
 * 哑铃形拱肋的上下弦就是这样得到的：法向永远落在竖直的拱平面里，
 * 所以靠近拱脚、切线变陡时，两根弦的间距方向也跟着转——这正是真实的截面朝向。
 */
function offsetCurveInPlane(curve, distance, samples = 48) {
  const points = curve.getPoints(samples);
  const offsetPoints = [];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const tangent = new THREE.Vector3().subVectors(next, previous).normalize();
    const normal = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize();
    offsetPoints.push(current.clone().addScaledVector(normal, distance));
  }
  return new THREE.CatmullRomCurve3(offsetPoints, false, "catmullrom", 0.5);
}

/* ------------------------------------------------------------------ *
 * 五座桥：按真实长宽建模（平面真实，竖向夸张）
 * ------------------------------------------------------------------ */

function metrics(bridge) {
  const L = Math.max(bridge.length, MIN_BRIDGE_LENGTH);
  const W = Math.max(bridge.width, MIN_BRIDGE_WIDTH);
  const deckY = 0.1 + L * 0.035;
  const deckT = 0.05 + L * 0.016;
  return { L, W, deckY, deckT };
}

function addParapets(group, L, W, deckY, deckT, material) {
  const railHeight = 0.05 + L * 0.004;
  for (const sign of [-1, 1]) {
    group.add(box(L, railHeight, 0.03, material, 0, deckY + deckT / 2 + railHeight / 2, (sign * W) / 2));
  }
}

function addPiers(group, L, W, deckY, concrete, count, spread) {
  for (let i = 0; i < count; i += 1) {
    const ratio = count === 1 ? 0 : (i / (count - 1) - 0.5) * 2 * spread;
    const x = ratio * (L / 2);
    const pierWidth = 0.1 + L * 0.012;
    const shaftHeight = deckY - PIER_BASE;
    group.add(
      box(pierWidth, shaftHeight, W * 1.6, concrete, x, PIER_BASE + shaftHeight / 2, 0)
    );
    group.add(box(pierWidth * 2.4, 0.05, W * 2.4, concrete, x, 0.025, 0));
  }
}

/**
 * 柳江大桥：三孔 T 型悬臂加挂梁的预应力钢筋混凝土桥（"柳州一桥"）。
 *
 * 真实资料（1963 年由林元培主持设计，1968-12-26 通车）：
 *   全长 608.04 m，桥宽 20 m；**主桥 408.19 m，由 3 个 T 构和挂梁组成，最大跨度 124 m**；
 *   中国第一座 T 型悬臂加吊梁体系的预应力钢筋混凝土桥，也是国内第一次用挂篮悬臂浇筑施工，
 *   1978 年获全国科学大会奖——柳州从此结束了靠浮桥和渡船过江的历史。
 *
 * 结构读法：每个 T 构 = 一根墩 + 向两侧挑出的悬臂（根部深、端部浅）；
 * 相邻两个 T 构的悬臂端之间再搁一段**挂梁**，把结构连起来。
 * 所以正立面是一串"深—浅—跳空—浅—深"的波形，中间那些方角缺口就是挂梁与悬臂的接缝。
 *
 * 旧模型是一件 L 形方块：一根通长箱体 + 2 根柱子，既没有 T 构，也没有挂梁。
 */
function buildGirder(bridge, accent, concrete, deckMaterial) {
  const { L, W, deckY, deckT } = metrics(bridge);

  // 桥面板只做薄薄一层铺装，梁高交给 T 构本身——
  // 上一版把整个 deckT（0.107，约 11 m）当桥面板，梁再薄也只有 0.075，
  // 立面上全被那层厚板吃掉，T 构的"深—浅"根本看不出来。
  const slabH = 0.026;
  const deckTop = deckY + slabH / 2;
  const girderTop = deckTop - slabH;
  const builder = createPartBuilder();

  // 1968 年的老桥：混凝土本色，栏杆刷白
  const railing = new THREE.MeshStandardMaterial({
    color: 0xe4e2d8,
    roughness: 0.74,
    metalness: 0.04
  });

  /* ---------------- 跨径布置 ---------------- */

  // 真实主桥 408.19 m = 边孔 80.1 + 主孔 124 + 主孔 124 + 边孔 80.1，
  // 三个 T 构立在 3 个墩上，四个孔里各搁一段挂梁。
  // 模型按 OSM 量到的桥长等比缩放，所以 124 m 的主孔在这里约 102 m。
  const total = L * 0.94;
  const METER = total / 408.2; // 1 m 真实长度对应的模型长度
  const spanEnd = 80.1 * METER;
  const spanMain = 124 * METER;
  const cantilever = 46 * METER; // 悬臂 46 m、主孔挂梁 32 m、边孔挂梁 34.1 m

  const rootDepth = 0.105; // 悬臂根（墩顶）梁高约 10.5 m
  const tipDepth = 0.036; // 悬臂端
  const dropDepth = 0.04; // 挂梁

  const startX = -total / 2;
  const piers = [];
  let cursor = startX;
  for (let i = 0; i < 3; i += 1) {
    cursor += i === 0 ? spanEnd : spanMain;
    piers.push(cursor);
  }
  const endX = startX + total;

  /* ---------------- 桥面 ---------------- */
  builder.beginPart("deck", "桥面");

  builder.box(total, slabH, W, deckMaterial, 0, deckY, 0);

  /* ---------------- 悬臂 + 挂梁 ---------------- */
  builder.beginPart("girder", "主梁");

  const armSegments = 6;

  /** 一段悬臂：从 fromX 到 toX，梁高从 depthFrom 变到 depthTo，顶面贴在桥面板下。 */
  const buildArm = (fromX, toX, depthFrom, depthTo) => {
    for (let s = 0; s < armSegments; s += 1) {
      const t0 = s / armSegments;
      const t1 = (s + 1) / armSegments;
      const x0 = fromX + (toX - fromX) * t0;
      const x1 = fromX + (toX - fromX) * t1;
      // 悬臂按抛物线收：根部陡、端部缓
      const depth = depthFrom + (depthTo - depthFrom) * (((t0 + t1) / 2) ** 1.35);
      builder.box(
        Math.abs(x1 - x0) + 0.004,
        depth,
        W * 0.88,
        concrete,
        (x0 + x1) / 2,
        girderTop - depth / 2,
        0
      );
    }
  };

  for (const pierX of piers) {
    buildArm(pierX - cantilever, pierX, tipDepth, rootDepth); // 左侧悬臂（自端向根）
    buildArm(pierX, pierX + cantilever, rootDepth, tipDepth); // 右侧悬臂（自根向端）
  }

  // 四个孔里的挂梁：两端各自看是不是墩——是墩就退一个悬臂长，是桥台就顶到底。
  // （上一版只判了左端是不是墩，最后一个边孔把 to 也算成了"右端减悬臂"，
  //  结果挂梁宽度变成负数，盒子的绕序翻面、法线与绕序相反。）
  const spans = [
    [startX, piers[0], false, true],
    [piers[0], piers[1], true, true],
    [piers[1], piers[2], true, true],
    [piers[2], endX, true, false]
  ];
  for (const [left, right, leftIsPier, rightIsPier] of spans) {
    const from = leftIsPier ? left + cantilever : left;
    const to = rightIsPier ? right - cantilever : right;
    builder.box(to - from, dropDepth, W * 0.84, concrete, (from + to) / 2, girderTop - dropDepth / 2, 0);
    // 支座：悬臂端与挂梁之间的垫块
    for (const x of [from, to]) {
      builder.box(0.024, 0.01, W * 0.52, concrete, x, girderTop - dropDepth - 0.005, 0);
    }
  }

  /* ---------------- 桥墩与桥台 ---------------- */
  builder.beginPart("pier", "桥墩");

  const rootBottom = girderTop - rootDepth;
  const supports = [];

  for (const pierX of piers) {
    const shaftHeight = rootBottom - PIER_BASE;
    builder.box(0.08, shaftHeight, W * 0.5, concrete, pierX, PIER_BASE + shaftHeight / 2, 0);
    builder.box(0.13, 0.03, W * 0.84, concrete, pierX, rootBottom - 0.015, 0); // 墩帽
    builder.box(0.24, 0.05, W * 0.96, concrete, pierX, PIER_BASE + 0.025, 0); // 承台
    supports.push({ x: pierX, bottom: PIER_BASE, top: rootBottom });
  }

  builder.beginPart("foundation", "基础");

  // 桥台：顶在挂梁底面，脚落到水下
  for (const side of [-1, 1]) {
    const x = side * (total / 2 - 0.06);
    const top = girderTop - dropDepth;
    const height = top - PIER_BASE;
    builder.box(0.08, height, W * 0.9, concrete, x, PIER_BASE + height / 2, 0);
    builder.box(0.22, 0.05, W * 0.96, concrete, x, PIER_BASE + 0.025, 0);
    supports.push({ x, bottom: PIER_BASE, top });
  }

  /* ---------------- 人行道与栏杆 ---------------- */
  builder.beginPart("deck", "桥面");

  // 人行道必须**高出路缘**：上一版把它做成与桥面板同厚的窄条，
  // 顶面正好落在桥面标高上（y 完全相同），于是两侧各出现一条 z-fighting 条纹。
  const sidewalkH = 0.024;
  const sidewalkWidth = W * 0.17;
  const railHeight = 0.042;
  const posts = Math.max(10, Math.round(total / 0.36));

  for (const side of [-1, 1]) {
    const sidewalkZ = side * (W / 2 - sidewalkWidth / 2);
    builder.box(total, sidewalkH, sidewalkWidth, concrete, 0, deckTop + sidewalkH / 2, sidewalkZ);

    const railZ = side * (W / 2 - 0.007);
    builder.box(total, 0.008, 0.01, railing, 0, deckTop + sidewalkH + railHeight, railZ);
    builder.box(total, 0.006, 0.008, railing, 0, deckTop + sidewalkH + railHeight * 0.5, railZ);
    for (let i = 0; i <= posts; i += 1) {
      const x = -total / 2 + (i / posts) * total;
      builder.box(0.006, railHeight, 0.01, railing, x, deckTop + sidewalkH + railHeight / 2, railZ);
    }
  }

  /* ---------------- 灯柱 ---------------- */

  // 1968 年的桥面：墩位两侧各一根简单灯柱（灯头是唯一的"装饰"）
  for (const pierX of piers) {
    for (const side of [-1, 1]) {
      const z = side * (W / 2 - W * 0.085);
      builder.box(0.012, 0.075, 0.012, railing, pierX, deckTop + 0.024 + 0.0375, z);
      builder.box(0.026, 0.012, 0.026, railing, pierX, deckTop + 0.024 + 0.081, z);
    }
  }

  const finished = builder.finish();
  finished.userData.deckTop = deckTop;
  finished.userData.supports = supports;
  finished.userData.girder = { rootDepth, tipDepth, dropDepth, cantilever, girderTop };
  return { group: finished, top: deckTop + sidewalkH + railHeight + 0.03 };
}

/**
 * 文惠桥：五孔连拱的中承式钢管混凝土拱桥。
 *
 * 真实结构（广西首座中承式钢管混凝土拱桥，1994 年通车）：
 *   主桥 483.4 m ＝ 3 孔净跨 108 m 中承式哑铃形钢管混凝土拱
 *                + 两边孔净跨 62 m 上承式钢筋混凝土箱肋拱，
 *   桥面双向四车道，拱肋漆成"中国红"——本地人因此叫它彩虹桥。
 *
 * 所以它**不是一道大拱**，而是五孔连拱：
 *   - 主跨（中承式）：拱肋从桥墩顶起拱、穿过桥面再升到桥面上方，
 *     桥面由吊杆吊在拱肋下弦上；拱脚到桥面这一段拱肋露在桥面以下。
 *   - 边跨（上承式）：混凝土箱肋拱整个压在桥面下方，桥面靠立柱坐在拱背上。
 *   - 每片拱肋是哑铃形截面（上下两根钢管 + 中间腹板），所以每跨看去是两条平行弦。
 *
 * 上一版把这些都省了：一根中心线上的圆管 + 一层吊杆 + 跨径 = 0.92 倍桥长（547 m，
 * 现实中不存在这种跨径的钢管混凝土拱桥）。远看只是个"拱形装饰"，
 * 近看既没有双肋，也没有中承式该有的"穿过桥面"的关系。
 */
function buildWenhuiBridge(bridge, accent, concrete, deckMaterial) {
  const { L, W, deckY, deckT } = metrics(bridge);
  const deckTop = deckY + deckT / 2;
  const deckBottom = deckY - deckT / 2;

  // 涂装钢材是电介质，不是裸金属：metalness 高了会吃掉漫反射，在远景里发闷发黑
  const steel = new THREE.MeshStandardMaterial({
    color: 0xc0472f,
    roughness: 0.55,
    metalness: 0.12
  });
  const railing = new THREE.MeshStandardMaterial({
    color: 0xe3e5e2,
    roughness: 0.68,
    metalness: 0.05
  });

  /* ---------------- 跨径布置 ---------------- */

  // 1 单位 = 100 m。净跨是**墩面之间**的距离，所以墩中心距还要加上一个墩厚。
  let mainSpan = 1.08;
  let sideSpan = 0.62;
  let pierWidth = 0.085 + mainSpan * 0.055;
  let archLength = mainSpan * 3 + sideSpan * 2 + pierWidth * 5;
  const limit = L * 0.94;
  if (archLength > limit) {
    const ratio = limit / archLength;
    mainSpan *= ratio;
    sideSpan *= ratio;
    pierWidth *= ratio;
    archLength = limit;
  }

  const archHalf = archLength / 2;

  // 六个墩位（两端为桥台）：相邻两墩中心距 = 净跨 + 墩厚
  const joints = [-archHalf];
  let cursor = -archHalf;
  cursor += sideSpan + pierWidth;
  joints.push(cursor);
  for (let i = 0; i < 3; i += 1) {
    cursor += mainSpan + pierWidth;
    joints.push(cursor);
  }
  cursor += sideSpan + pierWidth;
  joints.push(cursor);

  const springY = 0.1;
  const mainRise = mainSpan * 0.222 * VERTICAL; // 矢跨比 1/4.5，纵向按 VERTICAL 夸张
  const ribRadius = 0.016 + mainSpan * 0.008;
  const chordGap = ribRadius * 2.8; // 哑铃形：上下弦中心距
  const ribZ = W / 2 - Math.max(0.03, W * 0.09); // 拱肋贴着桥面两侧

  const builder = createPartBuilder();

  /* ---------------- 桥面 ---------------- */
  builder.beginPart("deck", "桥面梁");

  builder.box(L, deckT, W, deckMaterial, 0, deckY, 0);
  // 两侧边梁外露，桥面才不是一块薄片
  for (const side of [-1, 1]) {
    builder.box(L, deckT * 0.34, 0.022, concrete, 0, deckY - deckT * 0.1, (side * W) / 2);
  }

  /* ---------------- 栏杆：底座 + 立柱 + 扶手 ---------------- */

  const railHeight = 0.05;
  const posts = Math.max(6, Math.round(L / 0.42));
  for (const side of [-1, 1]) {
    const z = (side * W) / 2;
    builder.box(L, 0.01, 0.016, railing, 0, deckTop + 0.005, z);
    builder.box(L, 0.009, 0.012, railing, 0, deckTop + railHeight, z);
    for (let i = 0; i < posts; i += 1) {
      const x = -L / 2 + (L * i) / (posts - 1);
      builder.box(0.007, railHeight, 0.01, railing, x, deckTop + railHeight * 0.5, z);
    }
  }

  /* ---------------- 桥墩与桥台 ---------------- */
  builder.beginPart("abutment", "拱座");

  const shaftHeight = deckBottom - PIER_BASE;
  const pierXs = [...joints];
  const approachSpan = L / 2 - archHalf;
  if (approachSpan > 0.25) {
    // 拱段之外还有一段引桥，各落一个墩
    pierXs.push(-(archHalf + L / 2) / 2, (archHalf + L / 2) / 2);
  }
  for (const x of pierXs) {
    builder.box(pierWidth, shaftHeight, W * 0.96, concrete, x, PIER_BASE + shaftHeight / 2, 0);
    builder.box(pierWidth * 2.2, 0.05, W * 1.12, concrete, x, 0.028, 0);
  }

  /* ---------------- 五孔连拱 ---------------- */
  builder.beginPart("arch", "拱肋");

  for (let i = 0; i < joints.length - 1; i += 1) {
    const isSide = i === 0 || i === joints.length - 2;
    const from = joints[i] + pierWidth / 2;
    const to = joints[i + 1] - pierWidth / 2;
    const spanLength = to - from;
    const centerX = (from + to) / 2;

    // 边跨是上承式：拱必须整个躲在桥面下方，矢高由"桥面底 - 起拱点"反推
    const rise = isSide ? Math.max(0.1, deckBottom - 0.025 - 0.05) : mainRise;
    const baseY = isSide ? 0.05 : springY;

    const source = archCurve(spanLength, baseY, rise, 32);
    const baseCurve = new THREE.CatmullRomCurve3(
      source.getPoints(48).map((point) => new THREE.Vector3(point.x + centerX, point.y, 0)),
      false,
      "catmullrom",
      0.5
    );

    const archYAt = (x) => {
      const ratio = (2 * (x - centerX)) / spanLength;
      return baseY + rise * Math.max(0, 1 - ratio * ratio);
    };

    if (isSide) {
      /* 上承式：混凝土箱肋拱 + 立柱 */
      for (const side of [-1, 1]) {
        builder.tube(baseCurve, ribRadius * 1.7, concrete, 4, 30, side * ribZ);
      }
      const columns = 6;
      for (let c = 1; c < columns; c += 1) {
        const x = from + (spanLength * c) / columns;
        const archY = archYAt(x);
        const height = deckBottom - archY;
        if (height < 0.015) continue;
        for (const side of [-1, 1]) {
          builder.box(0.018, height, 0.026, concrete, x, archY + height / 2, side * ribZ);
        }
      }
    } else {
      /* 中承式：哑铃形拱肋（上下弦）+ 吊杆 + 横撑 */
      const upper = offsetCurveInPlane(baseCurve, chordGap / 2);
      const lower = offsetCurveInPlane(baseCurve, -chordGap / 2);
      for (const side of [-1, 1]) {
        builder.tube(upper, ribRadius, steel, 6, 40, side * ribZ);
        builder.tube(lower, ribRadius, steel, 6, 40, side * ribZ);
      }

      builder.beginPart("hanger", "吊杆");

      // 拱穿过桥面的两个交点：吊杆只存在于拱高于桥面的那一段
      const crossing = (spanLength / 2) * Math.sqrt(Math.max(0.04, 1 - (deckTop - baseY) / rise));
      const zone = crossing * 0.92;

      const hangers = 9;
      for (let h = 0; h < hangers; h += 1) {
        const t = hangers === 1 ? 0.5 : h / (hangers - 1);
        const x = centerX + (-1 + 2 * t) * zone;
        const top = archYAt(x) - chordGap / 2;
        if (top <= deckTop + 0.02) continue;
        for (const side of [-1, 1]) {
          builder.rod(
            new THREE.Vector3(x, deckTop, side * ribZ),
            new THREE.Vector3(x, top, side * ribZ),
            0.0065,
            steel,
            4
          );
        }
      }

      builder.beginPart("arch", "拱肋");

      // 拱上横撑：把两片拱肋连起来（哑铃形的面孔）
      for (const t of [-0.66, 0, 0.66]) {
        const x = centerX + t * zone;
        builder.box(0.018, 0.018, ribZ * 2, steel, x, archYAt(x), 0);
      }
      // 桥面以下的横撑：桥面挡住了大半，只有侧视才看得见
      for (const t of [0.8, 0.94]) {
        for (const side of [-1, 1]) {
          const x = centerX + side * t * (spanLength / 2);
          builder.box(0.016, 0.016, ribZ * 2, steel, x, archYAt(x), 0);
        }
      }
    }
  }

  const crownY = springY + mainRise + ribRadius;

  // 必须把桥面标高挂到模型组上：荷载实验的挠度曲线、荷载箭头与读数
  // 都靠 scene.mjs 的 bridgeMetrics 从这里读 deckTop。原先漏了这一行，
  // 导致文惠桥的荷载实验静默失效（没有曲线、没有读数、不报错）。
  const finished = builder.finish();
  finished.userData.deckTop = deckTop;
  return { group: finished, top: crownY + 0.12 };
}

/**
 * 文昌大桥：变截面预应力钢筋混凝土连续箱梁桥。
 *
 * 真实资料（2003-12 开工，2005-09-16 通车）：
 *   全长 1713 m，**主桥长 583 m，宽 29.5 m**，双向四车道；
 *   结构为**变截面预应力钢筋混凝土连续箱梁**；跨江时绕过柳江中的萝卜洲；
 *   通体涂为浅蓝色，与双冲大桥一起打破了柳州建桥史上"一桥一式"的传统。
 *
 * 结构读法：连续箱梁中间没有伸缩缝——梁高在墩顶最大（约 7 m）、往跨中收到约 3 m，
 * 正立面因此是一条连续的波浪线。"变截面"正是它跟等截面连续梁的区别，
 * 也是这一版唯一能远看认出来的特征。
 *
 * 旧模型是三层通长方块 + 3 根柱子，梁高处处一样，等于把"变截面"这个特征抹掉了。
 *
 * 已知简化：真实跨径布置查不到，这里按 5 等跨近似（每跨约 117 m，与 583 m 主桥相符）。
 */
function buildContinuous(bridge, accent, concrete, deckMaterial) {
  const { L, W, deckY, deckT } = metrics(bridge);

  // 同样：桥面板薄薄一层，梁高由变截面箱梁自己撑起来。
  // 上一版把 deckT（0.164，约 16 m）当成桥面箱体，梁高处处 0.164 不变化——
  // "变截面"这个唯一能远看认出来的特征就没了。
  const slabH = 0.026;
  const deckTop = deckY + slabH / 2;
  const girderTop = deckTop - slabH;
  const builder = createPartBuilder();

  // 真实桥"通体涂为浅蓝色"：箱梁与栏杆都刷这个色，只有桥面铺装是混凝土本色
  const paint = new THREE.MeshStandardMaterial({
    color: new THREE.Color().copy(accent.color).lerp(new THREE.Color(0xffffff), 0.55),
    roughness: 0.62,
    metalness: 0.08
  });
  const lamp = new THREE.MeshStandardMaterial({
    color: 0xf6f2e2,
    roughness: 0.5,
    metalness: 0.1,
    emissive: new THREE.Color(0xf6f2e2),
    emissiveIntensity: 0.3
  });

  /* ---------------- 跨径布置 ---------------- */

  const total = L * 0.94;
  const spanCount = 6;
  const spanLength = total / spanCount;
  const piers = [];
  const startX = -total / 2;
  for (let i = 1; i < spanCount; i += 1) piers.push(startX + i * spanLength);
  const endX = startX + total;

  const rootDepth = 0.085; // 墩顶梁高约 8.5 m
  const midDepth = 0.03; // 跨中梁高约 3 m

  /* ---------------- 桥面 ---------------- */
  builder.beginPart("deck", "桥面");

  builder.box(total, slabH, W, deckMaterial, 0, deckY, 0);

  /* ---------------- 变截面箱梁 ---------------- */
  builder.beginPart("box-girder", "连续箱梁");

  const segmentsPerSpan = 16;

  // 加深段只出现在墩顶附近（约占跨径 18%），离开这段就收到跨中梁高。
  // 上一版把整跨当作抛物线、又在分段中点采样，结果没有任何一段真正达到墩顶梁高，
  // 16 段全部 ≈ 跨中梁高——"变截面"等于没做。
  const haunchLength = spanLength * 0.18;
  const depthAt = (x) => {
    const local = (((x - startX) % spanLength) + spanLength) % spanLength;
    const toPier = Math.min(local, spanLength - local);
    const d = Math.min(1, toPier / haunchLength);
    return midDepth + (rootDepth - midDepth) * ((1 - d) ** 2);
  };

  const nodes = [startX];
  const totalSegments = spanCount * segmentsPerSpan;
  for (let i = 0; i < totalSegments; i += 1) {
    nodes.push(startX + ((i + 1) * total) / totalSegments);
  }

  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const x0 = nodes[i];
    const x1 = nodes[i + 1];
    const xm = (x0 + x1) / 2;
    // 取两端更深的一侧：贴着墩的那一段就是墩顶深梁
    const depth = Math.max(depthAt(x0), depthAt(x1));
    builder.box(x1 - x0 + 0.003, depth, W * 0.62, paint, xm, girderTop - depth / 2, 0);
  }

  // 箱梁到桥面全宽之间的挑臂：侧视是一条薄薄的挑檐
  for (const side of [-1, 1]) {
    builder.box(total, 0.018, W * 0.19, paint, 0, girderTop - 0.009, side * (W / 2 - W * 0.095));
  }

  /* ---------------- 桥墩与桥台 ---------------- */
  builder.beginPart("pier", "桥墩");

  const rootBottom = girderTop - rootDepth;
  const supports = [];

  for (const pierX of piers) {
    // 盖梁压低一个支座厚度，好让支座成为看得见、点得到的构件
    const bearingH = 0.012;
    const capTop = rootBottom - bearingH;
    const capBottom = capTop - 0.032;
    const columnHeight = capBottom - PIER_BASE;
    for (const side of [-1, 1]) {
      builder.box(0.06, columnHeight, W * 0.1, concrete, pierX, PIER_BASE + columnHeight / 2, side * W * 0.24);
    }
    builder.box(0.09, 0.032, W * 0.62, concrete, pierX, capTop - 0.016, 0); // 盖梁
    builder.beginPart("bearing", "支座");
    for (const side of [-1, 1]) {
      builder.box(0.05, bearingH, W * 0.22, concrete, pierX, capTop + bearingH / 2, side * W * 0.17);
    }
    builder.beginPart("pier", "桥墩");
    builder.box(0.26, 0.05, W * 0.8, concrete, pierX, PIER_BASE + 0.025, 0); // 承台
    supports.push({ x: pierX, bottom: PIER_BASE, top: capTop });
  }

  // 桥台：顶在梁底（端部也是深梁），脚落到水下
  for (const side of [-1, 1]) {
    const x = side * (total / 2 - 0.07);
    const height = rootBottom - PIER_BASE;
    builder.box(0.09, height, W * 0.84, concrete, x, PIER_BASE + height / 2, 0);
    builder.box(0.22, 0.05, W * 0.92, concrete, x, PIER_BASE + 0.025, 0);
    supports.push({ x, bottom: PIER_BASE, top: rootBottom });
  }

  /* ---------------- 栏杆与栏杆灯 ---------------- */
  builder.beginPart("deck", "桥面");

  const railHeight = 0.046;
  const posts = Math.max(12, Math.round(total / 0.3));
  for (const side of [-1, 1]) {
    const z = side * (W / 2 - 0.008);
    builder.box(total, 0.009, 0.011, paint, 0, deckTop + railHeight, z);
    builder.box(total, 0.007, 0.009, paint, 0, deckTop + railHeight * 0.45, z);
    for (let i = 0; i <= posts; i += 1) {
      const x = -total / 2 + (i / posts) * total;
      builder.box(0.007, railHeight, 0.011, paint, x, deckTop + railHeight / 2, z);
      // 每根栏杆柱上一盏灯（真实桥有 1900 余盏）
      builder.box(0.014, 0.014, 0.014, lamp, x, deckTop + railHeight + 0.012, z);
    }
  }

  const finished = builder.finish();
  finished.userData.deckTop = deckTop;
  finished.userData.supports = supports;
  finished.userData.girder = { rootDepth, midDepth, haunchLength, girderTop, spanLength };
  return { group: finished, top: deckTop + railHeight + 0.05 };
}

/**
 * 白沙大桥：单塔双索面钢箱梁斜拉桥（"柳州之门"）。
 *
 * 真实资料（2015 年动工，2018 年通车）：
 *   主桥长 400 m，**一跨而过**，只有中间一座主塔；桥面宽 38 m，双向六车道；
 *   主塔最高点 106 m，由**空间曲线扭曲**而成——相当于把两根笔直的钢塔在空中拧成"麻花"，
 *   单箱七室矩形截面，27 个钢节段共 4178 t；塔梁固结、全漂浮体系；
 *   全桥 60 根斜拉索，梁上索距 12 m、塔上索距 3 m；
 *   主塔形似门，俗称"柳州之门"，是世界最高、跨度最大的"反对称结构斜拉桥"。
 *
 * 旧模型是一个半径 1.78 单位（178 m）的圆环，还绕 y 轴转了 90°——
 * 环平面横跨桥宽，直径 356 m 架在一座 401 m 长的桥上，既没有索面也没有塔的概念。
 *
 * 现在的主塔按真实形态建：一个**被拧过的闭环**——椭圆在 x-y 平面里成形，
 * z 坐标随参数按 cos 摆动，于是环在桥面高度处岔开到桥面外侧、到塔顶又并回中线。
 * 桥面正好从环的"门洞"中穿过，这才是"柳州之门"。
 */
function buildCable(bridge, accent, concrete, deckMaterial) {
  const { L, W, deckY, deckT } = metrics(bridge);
  const deckTop = deckY + deckT / 2;
  const girderBottom = deckTop - deckT;
  const builder = createPartBuilder();

  // 塔与斜拉索都是浅色钢：真实桥的"门"是白色的，用 accent 反而认不出是白沙大桥
  const tower = new THREE.MeshStandardMaterial({
    color: 0xd9dee2,
    roughness: 0.44,
    metalness: 0.3
  });
  const stay = new THREE.MeshStandardMaterial({
    color: 0xe6e8e6,
    roughness: 0.5,
    metalness: 0.24
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x8f969c,
    roughness: 0.66,
    metalness: 0.22
  });

  /* ---------------- 主梁：钢箱 + 混凝土桥面板 ---------------- */
  builder.beginPart("deck", "漂浮桥面");

  const slabH = deckT * 0.36;
  const girderH = deckT * 0.64;
  builder.box(L, slabH, W, deckMaterial, 0, deckTop - slabH / 2, 0);
  builder.box(L, girderH, W * 0.56, steel, 0, deckTop - slabH - girderH / 2, 0);
  for (const side of [-1, 1]) {
    // 索面边梁：斜拉索就锚在这两条边梁上
    builder.box(L, girderH * 0.62, W * 0.07, steel, 0, deckTop - slabH - girderH * 0.31, side * (W / 2 - W * 0.035));
  }

  /* ---------------- 主塔：空间扭曲的闭环 ---------------- */
  builder.beginPart("ring", "环形主塔");

  const halfSpan = 0.5;                  // 环的半宽，100 m
  const towerTop = 1.06;                 // 塔顶 106 m（水面起算）
  const ringCenterY = towerTop / 2;      // 环心
  const halfHeight = towerTop / 2;       // 环半高 53 m
  const twist = 0.32;                    // z 向摆幅：麻花拧出来的进深

  const ringPoint = (theta) =>
    new THREE.Vector3(
      halfSpan * Math.cos(theta),
      ringCenterY + halfHeight * Math.sin(theta),
      twist * Math.cos(theta)
    );

  const ringPoints = [];
  const ringSegments = 96;
  for (let i = 0; i < ringSegments; i += 1) {
    ringPoints.push(ringPoint((i / ringSegments) * Math.PI * 2));
  }
  const ringCurve = new THREE.CatmullRomCurve3(ringPoints, true, "catmullrom", 0.5);
  builder.tube(ringCurve, 0.036, tower, 8, 160);

  // 塔脚：环底落在承台上
  builder.box(0.2, 0.3, 0.28, concrete, 0, PIER_BASE + 0.15, 0);
  builder.box(0.34, 0.05, 0.44, concrete, 0, PIER_BASE + 0.025, 0);

  /* ---------------- 斜拉索：单塔双索面，每侧 15 根 ---------------- */
  builder.beginPart("cable", "斜拉索");

  const perSide = 15;
  const cableRadius = 0.0052;
  for (const side of [-1, 1]) {
    for (let i = 1; i <= perSide; i += 1) {
      // 塔上索距 3 m：越远的索锚得越低
      const theta = ((90 - side * i * 3.1) * Math.PI) / 180;
      const anchor = ringPoint(theta);
      const deckX = side * (i * 0.12);
      if (Math.abs(deckX) > (L / 2) * 0.94) break;
      for (const plane of [-1, 1]) {
        const from = new THREE.Vector3(anchor.x, anchor.y, anchor.z * 0.82);
        const to = new THREE.Vector3(deckX, deckTop + 0.004, plane * (W / 2 - W * 0.035));
        builder.beginPart("cable", "斜拉索");

        builder.rod(from, to, cableRadius, stay, 4);
        builder.beginPart("anchor", "锚固区");

        // 索在梁上的锚头
        builder.box(0.012, 0.016, 0.012, steel, deckX, deckTop - 0.004, plane * (W / 2 - W * 0.035));
      }
    }
  }

  /* ---------------- 栏杆 ---------------- */
  builder.beginPart("deck", "漂浮桥面");

  const railHeight = 0.045;
  const posts = Math.max(8, Math.round(L / 0.4));
  for (const group of [builder]) {
    for (const side of [-1, 1]) {
      const z = (side * W) / 2;
      group.box(L, 0.008, 0.008, concrete, 0, deckTop + railHeight, z);
      group.box(L, 0.006, 0.006, concrete, 0, deckTop + railHeight * 0.52, z);
      for (let i = 0; i <= posts; i += 1) {
        const x = -L / 2 + (i / posts) * L;
        group.box(0.007, railHeight, 0.007, concrete, x, deckTop + railHeight / 2, z);
      }
    }
  }

  /* ---------------- 桥台 ---------------- */
  builder.beginPart("support", "桥台与基础");

  // 端部支撑必须"顶不穿桥面、脚不着空地悬着"这两头都不成立：
  // 顶面收在梁底以下，柱脚一直落到 PIER_BASE（低于水面/地面）。
  const supports = [];
  for (const side of [-1, 1]) {
    const x = side * (L / 2 - 0.085);
    const height = girderBottom - PIER_BASE;
    builder.box(0.08, height, W * 0.46, concrete, x, PIER_BASE + height / 2, 0);
    builder.box(0.15, 0.04, W * 0.72, concrete, x, PIER_BASE + 0.02, 0);
    builder.box(0.1, 0.045, W * 0.6, concrete, x, girderBottom - 0.0225, 0);
    // 端部支撑的真实上下界交给测试守着：柱脚要到水下、柱顶不许顶到桥面
    supports.push({ x, bottom: PIER_BASE, top: girderBottom });
  }

  const finished = builder.finish();
  finished.userData.deckTop = deckTop;
  finished.userData.supports = supports;
  return { group: finished, top: towerTop + 0.12 };
}

/**
 * 凤凰岭大桥：六跨连续钢-混组合梁 + 五座风雨亭 + 两侧长廊。
 *
 * 真实资料（2021-12-30 通车，世界跨径最大、体量最大的跨江风雨桥）：
 *   主梁跨径 700 m，顶推单跨最大 130 m，6 跨连续，等高双箱组合梁，梁高 6.5 m；
 *   桥面宽 46.6 m，公轨两用（双向 6 车道 + 非机动车道 + 人行道，预留轨道空间）；
 *   侗族风雨桥造型，5 座风雨亭——中间最高的是八边七层的八角亭，两侧是六角亭与歇山亭，
 *   亭上铺铜瓦，桥面两侧各一条长廊贯穿，把桥、亭、廊串成一体。
 *
 * **与实测结构的一处刻意偏离**：真实桥的五座桥亭立在中间那条 9 m 观景带（原预留轨道空间）上，
 * 车从亭子左右两侧通过；本场景按用户要求改成**横跨整个桥面、支柱落在桥面两侧**的门式亭，
 * 屋面罩住桥宽。亭高、层数、跨径布置仍用实测值。见 `buildPavilion` 里的说明。
 *
 * 旧模型是"五座小房子"：每座四根细柱加一个金字塔顶，没有廊、没有层级、没有组合梁断面。
 */
function buildPavilion(bridge, accent, concrete, deckMaterial) {
  const { L, W, deckY, deckT } = metrics(bridge);

  const deckTop = deckY + deckT / 2;
  const builder = createPartBuilder();

  // 铜瓦：新铜是红棕色，氧化后是铜绿。场景给这座桥的 accent 正好落在铜绿色系，
  // 于是屋面沿用它压暗一档，木构另给一个暖木色——两者分开，亭子才不会糊成一团。
  const timber = new THREE.MeshStandardMaterial({ color: 0x7d5f45, roughness: 0.85 });
  // accent 传进来的是整座桥共用的"强调材质"，不是颜色字符串。
  // 直接 new THREE.Color(material) 会让 Color 认不出参数，静默回落成纯白——
  // 第一版屋面就是这样渲成了灰白瓦。这里取材质自己的颜色再压暗。
  const roofMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color().copy(accent.color).multiplyScalar(0.7),
    roughness: 0.62,
    metalness: 0.16
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x5b6167,
    roughness: 0.72,
    metalness: 0.18
  });

  /* ---------------- 主梁：预制桥面板 + 双钢箱 ---------------- */
  builder.beginPart("deck", "桥面梁");

  const slabH = deckT * 0.42;
  const girderH = deckT * 0.58;
  builder.box(L, slabH, W, deckMaterial, 0, deckTop - slabH / 2, 0);
  for (const side of [-1, 1]) {
    builder.box(L, girderH, W * 0.16, steel, 0, deckTop - slabH - girderH / 2, side * W * 0.3);
    // 桥面板外挑，翼缘才不会是一条直线
    builder.box(
      L, slabH * 0.5, W * 0.1,
      deckMaterial, 0, deckTop - slabH * 0.74, side * (W * 0.45)
    );
  }
  const girderBottom = deckTop - slabH - girderH;

  // 真实横断面：机动车道 | **中间 9 m 预留轨道交通空间（兼观景台）** | 机动车道。
  // 9 m 是设计文件里的实测值，直接写死：不要拿 W 的比例去推，
  // OSM 量到的桥宽（60 m）比设计值（46.6 m）大得多，按比例算出来的分隔带会跟着变胖。
  const medianHalf = 0.045;
  builder.box(L, 0.014, medianHalf * 2, concrete, 0, deckTop + 0.007, 0);

  /* ---------------- 下部结构：真实跨径 96+124+3×130+90 = 700 m ---------------- */
  builder.beginPart("pier", "桥墩与基础");

  // 五座桥亭正好立在五个水中墩上——歇山亭在两端、六角亭次之、八角亭居中，
  // 所以跨径布置不能等分，要按真实的 96 / 124 / 130 / 130 / 130 / 90 来。
  const spanPattern = [96, 124, 130, 130, 130, 90];
  const spanSum = spanPattern.reduce((sum, value) => sum + value, 0);
  const total = L * 0.94;
  const startX = -total / 2;
  const pierX = [];
  let cursor = startX;
  for (let i = 0; i < spanPattern.length - 1; i += 1) {
    cursor += (spanPattern[i] / spanSum) * total;
    pierX.push(cursor);
  }

  const supports = [];
  for (const x of pierX) {
    const height = girderBottom - PIER_BASE;
    for (const side of [-1, 1]) {
      builder.box(0.055, height, 0.055, concrete, x, PIER_BASE + height / 2, side * W * 0.19);
    }
    // 盖梁 + 承台：桥面像是坐在墩上，而不是浮着
    builder.box(0.08, 0.05, W * 0.72, concrete, x, girderBottom - 0.025, 0);
    builder.box(0.14, 0.038, W * 0.88, concrete, x, PIER_BASE + 0.019, 0);
    supports.push({ x, bottom: PIER_BASE, top: girderBottom });
  }

  // 桥台：顶面收在梁底以下，柱脚落到 PIER_BASE
  for (const side of [-1, 1]) {
    const x = side * (L / 2 - 0.085);
    const height = girderBottom - PIER_BASE;
    builder.box(0.075, height, W * 0.44, concrete, x, PIER_BASE + height / 2, 0);
    builder.box(0.14, 0.04, W * 0.7, concrete, x, PIER_BASE + 0.02, 0);
    builder.box(0.095, 0.045, W * 0.58, concrete, x, girderBottom - 0.0225, 0);
    supports.push({ x, bottom: PIER_BASE, top: girderBottom });
  }

  /* ---------------- 两侧长廊 ---------------- */
  builder.beginPart("gallery", "连廊屋面");

  // 真实廊亭宽约 5.5 m、檐口 4.5 m、脊 6.8 m，压在人行道上、与五座桥亭并列通长。
  // 上一版做成 14 m 宽、15 m 高——比亭子的底层还高，远看像两道墙把桥夹住。
  const corridorHalf = 0.028;
  const corridorZ = W / 2 - Math.max(0.06, W * 0.12);
  const eaveY = deckTop + 0.045;
  const ridgeY = deckTop + 0.068;
  const postCount = Math.max(10, Math.round(L / 0.3));

  for (const side of [-1, 1]) {
    const zc = side * corridorZ;
    for (let i = 0; i <= postCount; i += 1) {
      const x = -L / 2 + (i / postCount) * L;
      for (const dz of [-corridorHalf * 0.78, corridorHalf * 0.78]) {
        builder.box(0.013, eaveY - deckTop, 0.013, timber, x, (deckTop + eaveY) / 2, zc + dz);
      }
    }
    // 双坡屋面：两片斜面在廊脊处相交
    const run = corridorHalf * 0.86;
    const rise = ridgeY - eaveY;
    const slope = Math.atan2(rise, run);
    const planeWidth = Math.hypot(run, rise);
    for (const dir of [-1, 1]) {
      builder.box(
        L, 0.008, planeWidth,
        roofMaterial,
        0, (eaveY + ridgeY) / 2, zc + (dir * run) / 2,
        dir * slope, 0, 0
      );
    }
    builder.box(L, 0.01, 0.016, timber, 0, ridgeY, zc);
    builder.box(L, 0.009, 0.013, timber, 0, eaveY, zc + side * corridorHalf);
    // 美人靠
    builder.box(L, 0.011, 0.014, timber, 0, deckTop + 0.038, zc - side * corridorHalf * 0.72);
  }

  /* ---------------- 五座桥亭：横跨整座桥面 ---------------- */
  builder.beginPart("pavilion", "风雨亭");

  // 【设计决定】按用户要求，亭子改成**横跨整个桥面**、支柱落在桥面两侧的方案。
  //
  // 说明：真实凤凰岭大桥的五座桥亭是立在中间那条 9 m 观景带（原预留轨道空间）上的，
  // 车从亭子左右两侧通过；这里改成柱子落在两侧人行道内侧、屋面罩住整个桥面的"门式"亭，
  // 是**刻意的艺术处理**，不是对实测结构的还原。好处是亭子撑满桥宽、气势够，
  // 而且柱子让开行车道，车道净空的约束依然成立。
  //
  // 亭高仍用实测值：八角亭 49.45 m（七层）、六角亭 43.9 m（七层）、歇山亭 34.2 m（五层）。
  const pavilionBaseY = deckTop + 0.012;

  /** 一座横跨桥面的门式桥亭：两侧柱列 + 层层叠檐 + 翘角 + 宝顶。 */
  const tower = (x, kind) => {
    const presets = {
      oct: { tiers: 7, height: 0.4945, halfX: 0.056, step: 0.82 },
      hex: { tiers: 7, height: 0.4389, halfX: 0.047, step: 0.8 },
      hip: { tiers: 5, height: 0.3422, halfX: 0.04, step: 0.76 }
    };
    const { tiers, height, halfX, step } = presets[kind];

    // 柱子落在桥面两侧（栏杆内侧留 2 m），中间完全空出来给行车道
    const halfZ = W / 2 - W * 0.03;
    const columnTopY = deckTop + 0.076; // 底层柱高 7.6 m，够车道净空
    const columnX = [-0.92, 0, 0.92].map((t) => x + t * halfX);

    for (const cx of columnX) {
      for (const sz of [-1, 1]) {
        // 柱础 + 柱
        builder.box(0.03, 0.014, 0.03, concrete, cx, pavilionBaseY + 0.007, sz * halfZ);
        builder.box(0.015, columnTopY - pavilionBaseY, 0.015, timber, cx, (pavilionBaseY + columnTopY) / 2, sz * halfZ);
      }
    }

    // 柱顶横梁：横桥向一道贯通的额枋，把两侧柱列连成一榀
    builder.box(halfX * 2.15, 0.018, halfZ * 2.06, timber, x, columnTopY + 0.009, 0);
    // 两侧柱间的美人靠
    for (const sz of [-1, 1]) {
      builder.box(halfX * 1.9, 0.012, 0.016, timber, x, deckTop + 0.043, sz * (halfZ - 0.035));
    }

    // 逐层叠檐：第一层就罩住整个桥面，往上逐层收分。
    // height 是"含宝顶"的实测总高，所以宝顶要先从檐身里扣出来，否则总高多算一个宝顶。
    const crownH = height * 0.11;
    const topY = pavilionBaseY + height - crownH;
    const tierH = (topY - columnTopY) / tiers;
    let hx = halfX * 1.2;
    let hz = halfZ * 1.08;

    for (let i = 0; i < tiers; i += 1) {
      const y0 = columnTopY + i * tierH;
      // 亭身
      builder.box(hx * 1.44, tierH * 0.5, hz * 1.44, timber, x, y0 + tierH * 0.25, 0);
      // 檐：四坡屋面，底座正好坐在亭身顶上
      builder.shape(pyramidRoof(hx * 2, tierH * 0.62, hz * 2), roofMaterial, x, y0 + tierH * 0.81, 0);
      // 翘角
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const inner = new THREE.Vector3(x + sx * hx * 0.9, y0 + tierH * 0.52, sz * hz * 0.9);
          const outer = new THREE.Vector3(x + sx * hx * 1.08, y0 + tierH * 0.7, sz * hz * 1.08);
          builder.rod(inner, outer, 0.0045, roofMaterial, 4);
        }
      }
      hx *= step;
      hz *= step;
    }

    // 宝顶
    builder.cone(0.004, 0.016, crownH, 8, roofMaterial, x, topY + crownH / 2, 0);
    return { top: pavilionBaseY + height, halfZ };
  };

  const kinds = ["hip", "hex", "oct", "hex", "hip"];
  const pavilions = [];
  let highest = -Infinity;
  for (let i = 0; i < kinds.length; i += 1) {
    const x = pierX[i];
    const result = tower(x, kinds[i]);
    pavilions.push({
      kind: kinds[i],
      x,
      top: result.top,
      halfZ: result.halfZ,
      heightAboveDeck: result.top - deckTop
    });
    if (result.top > highest) highest = result.top;
  }

  const finished = builder.finish();
  // 桥面标高、分隔带宽、长廊与桥亭的位置都交给测试：
  // 车道净空、亭子最高这些结构性约束要能被断言守住，而不是靠肉眼看。
  finished.userData.deckTop = deckTop;
  finished.userData.medianHalf = medianHalf;
  finished.userData.corridor = { z: corridorZ, half: corridorHalf, eaveY, ridgeY };
  finished.userData.pavilions = pavilions;
  finished.userData.spans = { pattern: spanPattern, startX, endX: startX + total, piers: pierX };
  finished.userData.supports = supports;
  return { group: finished, top: highest + 0.12 };
}

const BUILDERS = {
  girder: buildGirder,
  arch: buildWenhuiBridge,
  continuous: buildContinuous,
  cable: buildCable,
  pavilion: buildPavilion
};

/* ------------------------------------------------------------------ *
 * 建筑
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 场景装配
 * ------------------------------------------------------------------ */

/**
 * 构建整个场景内容。
 *
 * @param {{ theme?: string }} [options] theme 是主题 id（目前只有 day）。
 *   主题由参数传入，配色全部从这里推导，改动配色只需改 theme.mjs。
 */
export function buildAtlas(options = {}) {
  const theme = getTheme(options.theme);
  const THEME = theme; // 兼容函数内既有写法
  const COLOR = buildPalette(theme);
  const root = new THREE.Group();
  const pickables = [];
  const bridges = new Map();
  const labelItems = [];

  const viewWindow = GEO.window;
  const centerX = (viewWindow.minX + viewWindow.maxX) / 2;
  const centerZ = (viewWindow.minZ + viewWindow.maxZ) / 2;
  const width = viewWindow.maxX - viewWindow.minX;
  const depth = viewWindow.maxZ - viewWindow.minZ;

  const concrete = new THREE.MeshStandardMaterial({ color: COLOR.concrete, roughness: 0.9 });
  concrete.name = "concrete";
  const deckMaterial = new THREE.MeshStandardMaterial({ color: COLOR.deck, roughness: 0.8 });
  deckMaterial.name = "deck";

  // 地面：地形网格 + 外接平地裙边
  //
  // 地形网格覆盖比取景窗口略大的范围，外圈已淡出到 y=0；
  // 网格之外用四块平地补到雾的尽头，两边同为 0 高度，严丝合缝。
  // 不再是"一张大平板"——那样的盆地没有起伏，九座孤峰也就没地方立。
  const extent = GEO.fullExtent || viewWindow;
  const groundMinX = Math.min(viewWindow.minX, extent.minX) - GROUND_MARGIN;
  const groundMaxX = Math.max(viewWindow.maxX, extent.maxX) + GROUND_MARGIN;
  const groundMinZ = Math.min(viewWindow.minZ, extent.minZ) - GROUND_MARGIN;
  const groundMaxZ = Math.max(viewWindow.maxZ, extent.maxZ) + GROUND_MARGIN;

  const terrain = createTerrain(root, theme);
  const terrainHeightAt = terrain.heightAt;
  const terrainSurfaceAt = terrain.surfaceHeightAt;

  const frameMaterial = new THREE.MeshStandardMaterial({
    name: "frame",
    color: toHex(theme.terrain.basin),
    roughness: 1,
    metalness: 0
  });
  const groundFrame = [];
  const addFrame = (minX, maxX, minZ, maxZ) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ), frameMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((minX + maxX) / 2, GROUND_Y, (minZ + maxZ) / 2);
    mesh.receiveShadow = true;
    groundFrame.push(mesh);
    root.add(mesh);
  };
  addFrame(groundMinX, groundMaxX, groundMinZ, TERRAIN.minZ);
  addFrame(groundMinX, groundMaxX, TERRAIN.maxZ, groundMaxZ);
  addFrame(groundMinX, TERRAIN.minX, TERRAIN.minZ, TERRAIN.maxZ);
  addFrame(TERRAIN.maxX, groundMaxX, TERRAIN.minZ, TERRAIN.maxZ);

  // 河道：真实折线 → 平滑曲线 → 江面
  //
  // 这里只保留**一层**水面。曾经江面之上还叠了岸带（沙滩）和岸线两条装饰带，
  // 它们是水平面片且彼此重叠：壶城发卡弯内侧两条岸带大面积交叠，岸边条带又压在大带上面，
  // 间距再大也追不上深度精度随距离的衰减，于是无论怎么调都会在特定缩放下闪烁。
  // 既然沙滩本身也不好看，直接去掉——少两层几何，闪烁的根源一并消失。
  const halfWidth = GEO.riverHalfWidth;
  const curves = GEO.rivers.map((line) => curveFromPolyline(line));
  const waterMeshes = [];

  const waterMaterial = new THREE.MeshStandardMaterial({
    name: "water",
    color: COLOR.water,
    roughness: theme.water.roughness,
    metalness: theme.water.metalness,
    side: THREE.DoubleSide,
    // 与地面同高，靠深度偏移稳定压在地面之上（贴花），
    // 不靠抬高几何来分胜负——抬高会在掠射角看到缝隙。
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2
  });

  for (const curve of curves) {
    const segments = Math.max(120, Math.round(curve.getLength() * 6));
    const water = new THREE.Mesh(riverSurface(curve, halfWidth, WATER_Y, segments), waterMaterial);
    waterMeshes.push(water);
    root.add(water);
  }

  // 五座桥：真实位置与朝向
  for (const geoBridge of GEO.bridges) {
    const meta = BRIDGES.find((item) => item.id === geoBridge.id);
    if (!meta) continue;

    // 自发光基线 0.12：强调（选中/悬停）在此之上叠加，见 emphasisFor()。
    const accent = new THREE.MeshStandardMaterial({
      color: new THREE.Color(meta.accent),
      emissive: new THREE.Color(meta.accent),
      emissiveIntensity: 0.12,
      roughness: 0.55,
      metalness: 0.12
    });

    const build = BUILDERS[meta.model] || buildGirder;
    const model = build(geoBridge, accent, concrete, deckMaterial);

    const group = new THREE.Group();
    group.add(model.group);
    group.position.set(geoBridge.x, 0, geoBridge.z);
    group.rotation.y = geoBridge.angle;
    group.userData.pick = { type: "bridge", id: meta.id };

    // 构件拾取：每个构件网格自带 pick，点上去就能拿到"拱肋/吊索/桥墩"这一级。
    // 没有构件标记的网格落到桥一级（拾取代理就是干这个的）。
    const partMap = model.group.userData && model.group.userData.parts;
    if (partMap) {
      for (const part of partMap.values()) {
        for (const mesh of part.meshes) {
          mesh.userData.pick = {
            type: "part",
            id: meta.id,
            partId: part.id,
            label: part.label
          };
        }
      }
    }

    // 拾取代理：让 3 单位的桥在总览里也能被点中
    const proxy = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(geoBridge.length, 3) + 2, 3.2, Math.max(geoBridge.width, 1.2) + 2),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    proxy.position.y = 1.2;
    group.add(proxy);

    // 光标记：总览里指示桥梁位置
    const markerSize = 0.55 + geoBridge.length * 0.06;
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(markerSize, markerSize * 1.18, 40),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(meta.accent),
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
      })
    );
    marker.rotation.x = -Math.PI / 2;
    // 同样贴在水面上当贴花：抬高会在掠射角看成一枚悬浮的圆环
    marker.position.y = WATER_Y + 0.016;
    group.add(marker);

    root.add(group);
    pickables.push(group);
    bridges.set(meta.id, {
      group,
      accent,
      marker,
      top: model.top,
      parts: partMap || new Map(),
      labelAnchor: new THREE.Vector3(geoBridge.x, model.top + 0.5, geoBridge.z)
    });

    labelItems.push({
      key: `bridge:${meta.id}`,
      type: "bridge",
      id: meta.id,
      text: meta.name,
      sub: `${geoBridge.length}×${geoBridge.width} 单位`,
      accent: meta.accent,
      position: new THREE.Vector3(geoBridge.x, model.top + 0.8, geoBridge.z)
    });
  }
  // 标签副标题改用更友好的说法
  for (const item of labelItems) {
    if (item.type !== "bridge") continue;
    const meta = BRIDGES.find((entry) => entry.id === item.id);
    if (meta) item.sub = `${meta.year} · ${meta.type}`;
  }

  // 城市街区（占位楼群）已整体移除：v2.4 起地形是真实 DEM 高度场，
  // 随机撒下的方块会落在山坡上，与"山体"争视觉。楼群等真实建筑足迹数据到位后重建。

  /* 选中与悬停 */

  let selection = { view: "atlas", bridgeId: null };
  let hoveredKey = null;

  // 自发光基线：强调（选中/悬停）在此基础上叠加。
  const glowBase = 0.12;

  // 构件高亮：复用构件几何建一层半透明"幽灵"，只加材质不加顶点。
  // 直接用材质改发光是不行的——同一材质被多个构件共用，改一个会亮一片。
  const highlightMaterials = {
    select: new THREE.MeshStandardMaterial({
      color: 0xffe6b0,
      emissive: new THREE.Color(0xffcf6a),
      emissiveIntensity: 0.9,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide
    }),
    // 受力演示用玫红，和"我点中了"的琥珀区分开
    force: new THREE.MeshStandardMaterial({
      color: 0xff9db2,
      emissive: new THREE.Color(0xff5f86),
      emissiveIntensity: 1.05,
      roughness: 0.45,
      metalness: 0.08,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      side: THREE.DoubleSide
    }),
    // 实验室的受力配色：受拉偏暖红、受压偏冷蓝
    tension: new THREE.MeshStandardMaterial({
      color: 0xff7a63,
      emissive: new THREE.Color(0xff3d24),
      emissiveIntensity: 0.85,
      roughness: 0.5,
      metalness: 0.06,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      side: THREE.DoubleSide
    }),
    compression: new THREE.MeshStandardMaterial({
      color: 0x74b6ff,
      emissive: new THREE.Color(0x2f7fff),
      emissiveIntensity: 0.8,
      roughness: 0.5,
      metalness: 0.06,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      side: THREE.DoubleSide
    }),
    bending: new THREE.MeshStandardMaterial({
      color: 0xc8a4ff,
      emissive: new THREE.Color(0x8b5cf6),
      emissiveIntensity: 0.75,
      roughness: 0.5,
      metalness: 0.06,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      side: THREE.DoubleSide
    }),
    load: new THREE.MeshStandardMaterial({
      color: 0xffd479,
      emissive: new THREE.Color(0xffb020),
      emissiveIntensity: 0.8,
      roughness: 0.5,
      metalness: 0.06,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide
    }),
    transfer: new THREE.MeshStandardMaterial({
      color: 0x9fe0c8,
      emissive: new THREE.Color(0x2fbf94),
      emissiveIntensity: 0.6,
      roughness: 0.55,
      metalness: 0.06,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  };
  let highlighted = { bridgeId: null, partId: null, meshes: [] };

  /**
   * 拆解的竖向位移（单位：世界单位，1 = 100 m）。
   * 规律：下部结构原地或下沉，桥面抬升，上部承重构件抬得最高——
   * 这样一眼能看出"谁压在谁上面"。
   */
  const EXPLODE_OFFSET = {
    foundation: -0.06,
    support: -0.06,
    pier: 0,
    abutment: 0,
    bearing: 0.02,
    deck: 0.1,
    girder: 0.07,
    "box-girder": 0.07,
    hanger: 0.14,
    anchor: 0.12,
    cable: 0.18,
    ring: 0.18,
    arch: 0.2,
    gallery: 0.14,
    pavilion: 0.24
  };
  const explodeTargets = new Map(); // mesh -> 目标 y
  let explodedBridge = null;

  /** 清除当前构件高亮。 */
  function clearPartHighlight() {
    for (const mesh of highlighted.meshes) {
      if (mesh.parent) mesh.parent.remove(mesh);
    }
    highlighted = { bridgeId: null, partId: null, meshes: [] };
  }

  /**
   * 高亮某个构件。
   * @returns {{id: string, label: string}|null} 命中的构件（找不到则为 null）
   */
  /**
   * 同时高亮多个构件，每个可以有自己的配色。
   * entries = [{ partId, style }]（实验室的受力配色就靠它一次画满整座桥）
   * @returns {{id:string,label:string}|null} 第一个命中的构件
   */
  function highlightParts(bridgeId, entries) {
    clearPartHighlight();
    if (!bridgeId || !Array.isArray(entries) || entries.length === 0) return null;
    const entry = bridges.get(bridgeId);
    if (!entry || !entry.parts) return null;

    const ghosts = [];
    let first = null;
    const painted = [];
    for (const item of entries) {
      const part = entry.parts.get(item.partId);
      if (!part) continue;
      const material = highlightMaterials[item.style] || highlightMaterials.select;
      for (const source of part.meshes) {
        const ghost = new THREE.Mesh(source.geometry, material);
        ghost.userData.noPick = true;
        ghost.castShadow = false;
        ghost.receiveShadow = false;
        ghost.renderOrder = 2;
        source.parent.add(ghost);
        ghosts.push(ghost);
      }
      painted.push(item.partId);
      if (!first) first = { id: part.id, label: part.label };
    }
    highlighted = { bridgeId, partId: painted.join(","), meshes: ghosts };
    return first;
  }

  function highlightPart(bridgeId, partId, style = "select") {
    return highlightParts(bridgeId, [{ partId, style }]);
  }

  function emphasisFor(id) {
    const key = `bridge:${id}`;
    const selected = selection.view === "bridge" && selection.bridgeId === id;
    const dimmed = selection.view === "bridge" && selection.bridgeId !== id;
    if (selected) return { scale: 1.16, lift: 0.12, glow: 0.85, ring: 0.95 };
    if (hoveredKey === key) return { scale: 1.08, lift: 0.05, glow: 0.6, ring: 0.7 };
    if (dimmed) return { scale: 1, lift: 0, glow: 0.02, ring: 0.08 };
    return { scale: 1, lift: 0, glow: 0.12, ring: 0.32 };
  }

  function apply() {
    for (const [id, entry] of bridges) {
      const emphasis = emphasisFor(id);
      entry.group.scale.setScalar(emphasis.scale);
      entry.group.position.y = emphasis.lift;
      entry.accent.emissiveIntensity = glowBase + emphasis.glow;
      entry.marker.material.opacity = emphasis.ring;
    }
  }

  function setSelection(next) {
    selection = { view: next.view, bridgeId: next.bridgeId };
    apply();
  }

  /**
   * 打开/关闭某座桥的分层拆解。
   * 只改网格的 position.y，几何本身不动，所以关掉就能精确复位。
   */
  function setExploded(bridgeId) {
    explodeTargets.clear();
    explodedBridge = bridgeId || null;
    if (!explodedBridge) return [];
    const entry = bridges.get(explodedBridge);
    if (!entry || !entry.parts) return [];
    const moved = [];
    for (const [partId, part] of entry.parts) {
      const offset = EXPLODE_OFFSET[partId];
      if (!offset) continue;
      for (const mesh of part.meshes) explodeTargets.set(mesh, offset);
      moved.push(partId);
    }
    return moved;
  }

  /** 每帧推进拆解动画（指数逼近，帧率无关）。 */
  function updateExplode(damping = 0.16) {
    // 全部网格先回收：未在 targets 里的要回原位
    for (const entry of bridges.values()) {
      if (!entry.parts) continue;
      for (const part of entry.parts.values()) {
        for (const mesh of part.meshes) {
          const target = explodeTargets.get(mesh) || 0;
          mesh.position.y += (target - mesh.position.y) * damping;
          if (Math.abs(mesh.position.y - target) < 1e-4) mesh.position.y = target;
        }
      }
    }
  }

  function setHover(key) {
    // 构件悬停按桥级强调处理：key 形如 part:<bridgeId>:<partId>，
    // 归一成 bridge:<bridgeId> 再比较，省一套额外的强调逻辑。
    if (key && key.startsWith("part:")) {
      const [, bridgeId] = key.split(":");
      key = `bridge:${bridgeId}`;
    }
    if (hoveredKey === key) return;
    hoveredKey = key;
    apply();
  }

  apply();

  // 阴影开关统一在这里定，避免每处几何各自记一遍：
  //   - 实心几何（桥、场馆、屋顶、山体）既投影也接收；
  //   - 江面只接收不投影——水面若投影会把自己整片压暗；
  //   - 半透明标记环和不可见的拾取代理不参与，否则地上会多出一个怪圈。
  root.traverse((object) => {
    if (!object.isMesh) return;
    const material = object.material;
    const skip = !material || material.transparent || material.visible === false;
    object.castShadow = !skip;
    object.receiveShadow = !skip;
  });
  for (const piece of groundFrame) {
    piece.castShadow = false;
    piece.receiveShadow = true;
  }
  for (const mesh of waterMeshes) {
    mesh.castShadow = false;
    mesh.receiveShadow = true;
  }

  return {
    root,
    pickables,
    theme: { id: theme.id, label: theme.label },
    bridges,
    labels: labelItems,
    curves,
    heightAt: terrainHeightAt,
    surfaceHeightAt: terrainSurfaceAt,
    center: { x: centerX, z: centerZ },
    window: viewWindow,
    setSelection,
    setHover,
    setExploded,
    updateExplode,
    explodeOffsets: EXPLODE_OFFSET,
    highlightPart,
    highlightParts,
    clearPartHighlight,
    get hovered() {
      return hoveredKey;
    }
  };
}
