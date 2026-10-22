/**
 * 城市管线：OSM 建筑足迹 + 道路 → app3d/city.mjs
 *
 * ⚠️ **本版场景不使用这个产物**（v3.0 起场景只保留山体、江与桥）。
 * 脚本与已调好的数据管线保留在这里，是为了需要时能一条命令拉回来：
 *
 *   node tools/build-city.mjs               # 生成 app3d/city.mjs（仅楼群）
 *   node tools/build-city.mjs --with-roads  # 连道路一起生成
 *   node tools/build-city.mjs --refetch     # 忽略缓存重新抓
 *
 * 拉回来之后还要在 app3d/atlas.mjs 里重新接线（导入 CITY、建 InstancedMesh、
 * 道路条带），相关实现见 docs/3D重构开发计划.md 的 v2.5–v2.8。
 *
 * 数据来源：OpenStreetMap contributors，许可 ODbL-1.0。
 *   投影与 tools/build-geo.mjs 完全一致（等距圆柱，原点 24.342,109.420，1 世界单位 = 100 米），
 *   否则楼群会和河道、桥梁错位。
 *
 * 设计取舍（对应 docs/research/03-城市与建筑.md）：
 *
 * 1. **足迹 → 最小外接矩形**，不做逐栋挤出。
 *    一栋楼在默认视距下只有 1–2 像素宽，保留凹凸形状毫无意义；反而每栋一个旋转矩形盒
 *    刚好能进 InstancedMesh（单位盒 + 逐实例变换），全城 1–2 个 draw call。
 *    方向用凸包的最小面积外接矩形求，柳州街区多沿江倾斜，用轴对齐包围盒会明显放大体量。
 *
 * 2. **楼高必须推算**：全城带 height 标签的只有 6 栋（恰好是地标超高层）、
 *    带 building:levels 的 46 栋（1.6%）。其余按类型底值 × 确定性抖动，
 *    抖动用 id 做种，保证每次重建结果一致。
 *
 * 3. **道路默认不生成**（`--with-roads` 才跑）。取用 trunk/primary 两级，
 *    bridge/tunnel 段落剔除，横穿江面的路段按江面切段。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GEO } from "../app3d/geo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE_DIR = path.join(HERE, ".cache", "city");
const OUT_FILE = path.join(ROOT, "app3d", "city.mjs");

const UA = "bridge-observatory-liuzhou/1.0 (educational static site)";

const ORIGIN = { lat: 24.342, lon: 109.42 };
const METERS_PER_UNIT = 100;
const EARTH_R = 6378137;
const COS_LAT = Math.cos((ORIGIN.lat * Math.PI) / 180);

/** 与 terrain.mjs 同一范围：地形网格到哪儿，城市就铺到哪儿。 */
const BOX = { minX: -48, maxX: 36, minZ: -68, maxZ: 58 };

/** 抓取范围比渲染范围再外扩一点，避免边界处的楼被裁掉半截。 */
const FETCH_MARGIN = 3;

/** 最小保留面积（单位²）：1 单位² = 10000 m²，0.004 ≈ 40 m²，更小的多是车棚雨棚。 */
const MIN_BUILDING_AREA = 0.004;

/**
 * 道路等级 → 路面宽度（米）。**只保留快速路 + 主干路两级骨架。**
 *
 * 取舍经过三轮实测：
 * - 五级全画（1566 条）：tertiary/residential 共 959 条，6–9 m 宽在默认视距下
 *   只有 0.4–0.6 像素，叠成一片灰噪点，反而把路网骨架糊掉了。
 * - 三级（524 条）：次干路 12 m 仍偏碎，整张图还是"蜘蛛网"。
 * - 两级（本版）：只留 trunk + primary，才读得出"城市骨架"。
 */
const ROAD_CLASSES = {
  trunk: 26,
  primary: 18
};

/** 道路折线简化容差（米）。放宽到 10 m，让线条更"示意图"一点。 */
const ROAD_SIMPLIFY_METERS = 10;

/** 太短的残段直接丢掉（江面切段的产物、路口碎片），留着就是噪点。 */
const MIN_ROAD_LENGTH = 0.4;

const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 投影
 * ------------------------------------------------------------------ */

const project = (lat, lon) => [
  ((lon - ORIGIN.lon) * Math.PI * EARTH_R * COS_LAT) / (180 * METERS_PER_UNIT),
  (-(lat - ORIGIN.lat) * Math.PI * EARTH_R) / (180 * METERS_PER_UNIT)
];

const unproject = (x, z) => ({
  lon: ORIGIN.lon + (x * METERS_PER_UNIT * 180) / (Math.PI * EARTH_R * COS_LAT),
  lat: ORIGIN.lat + (-z * METERS_PER_UNIT * 180) / (Math.PI * EARTH_R)
});

/* ------------------------------------------------------------------ *
 * Overpass（带磁盘缓存与镜像回退）
 * ------------------------------------------------------------------ */

async function overpass(query, label) {
  for (const server of SERVERS) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(server, {
          method: "POST",
          headers: {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({ data: query })
        });
        const text = await response.text();
        if (response.ok && text.includes('"elements"')) {
          console.log(`  [${label}] ${server.split("/")[2]} ok ${(text.length / 1024).toFixed(0)} KB`);
          return JSON.parse(text);
        }
        console.log(`  [${label}] ${server.split("/")[2]} status=${response.status} retry`);
      } catch (error) {
        console.log(`  [${label}] ${server.split("/")[2]} ${error.message}`);
      }
      await sleep(4000 * (attempt + 1));
    }
  }
  throw new Error(`[${label}] all mirrors failed`);
}

async function cachedJson(name, query, label, refetch) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, name);
  if (!refetch && fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    if (text.includes('"elements"')) {
      console.log(`  [${label}] cache hit ${(text.length / 1024).toFixed(0)} KB`);
      return JSON.parse(text);
    }
  }
  const data = await overpass(query, label);
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
  return data;
}

/**
 * 把范围切成网格分块抓取。整块一次查会踩 Overpass 的内存/超时限制，
 * 分成小格后单次响应都在几百 KB 量级，失败也能单独重试。
 */
function makeCells(cols, rows) {
  const cells = [];
  const spanX = BOX.maxX - BOX.minX;
  const spanZ = BOX.maxZ - BOX.minZ;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x0 = BOX.minX - FETCH_MARGIN + (spanX + FETCH_MARGIN * 2) * (c / cols);
      const x1 = BOX.minX - FETCH_MARGIN + (spanX + FETCH_MARGIN * 2) * ((c + 1) / cols);
      const z0 = BOX.minZ - FETCH_MARGIN + (spanZ + FETCH_MARGIN * 2) * (r / rows);
      const z1 = BOX.minZ - FETCH_MARGIN + (spanZ + FETCH_MARGIN * 2) * ((r + 1) / rows);
      const nw = unproject(x0, z0);
      const se = unproject(x1, z1);
      // Overpass 的 bbox 顺序是 (south, west, north, east)
      cells.push({
        id: `${r}-${c}`,
        bbox: [se.lat.toFixed(5), nw.lon.toFixed(5), nw.lat.toFixed(5), se.lon.toFixed(5)]
      });
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ *
 * 几何工具
 * ------------------------------------------------------------------ */

/** 鞋带公式，返回单位²。 */
function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.abs(sum) / 2;
}

/** Andrew monotone chain 凸包，逆时针。 */
function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length < 3) return pts;

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * 最小面积外接矩形：对凸包每条边取一个坐标系，量包围盒面积，取最小。
 * 返回 { cx, cz, w, d, rot }，其中 rot 可直接赋给 three 的 rotation.y。
 */
function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length < 3) return null;

  let best = null;

  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;

    for (const [x, z] of hull) {
      const u = x * ca + z * sa;
      const v = -x * sa + z * ca;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      best = { area, angle, ca, sa, minU, maxU, minV, maxV };
    }
  }

  const u = (best.minU + best.maxU) / 2;
  const v = (best.minV + best.maxV) / 2;

  return {
    cx: u * best.ca - v * best.sa,
    cz: u * best.sa + v * best.ca,
    w: best.maxU - best.minU,
    d: best.maxV - best.minV,
    // three 的 rotation.y = θ 把局部 +X 转到世界 (cosθ, -sinθ)，故取负角
    rot: -best.angle
  };
}

/** Douglas–Peucker 简化（闭合折线按开口处理，终点保留）。 */
function simplify(points, tolerance) {
  if (points.length <= 2) return points.slice();

  const sqTolerance = tolerance * tolerance;

  const sqSegmentDistance = (p, a, b) => {
    let x = a[0];
    let z = a[1];
    let dx = b[0] - x;
    let dz = b[1] - z;
    if (dx !== 0 || dz !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - z) * dz) / (dx * dx + dz * dz);
      if (t > 1) {
        x = b[0];
        z = b[1];
      } else if (t > 0) {
        x += dx * t;
        z += dz * t;
      }
    }
    dx = p[0] - x;
    dz = p[1] - z;
    return dx * dx + dz * dz;
  };

  const out = [points[0]];
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const distance = sqSegmentDistance(points[i], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (maxDistance > sqTolerance && index !== -1) {
      stack.push([first, index], [index, last]);
    } else {
      out.push(points[last]);
    }
  }

  return out;
}

/** 由 OSM id 得到的确定性 [0,1) 随机数。 */
function hash01(id) {
  let h = Math.imul(id | 0, 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const round2 = (value) => Math.round(value * 100) / 100;

/* ------------------------------------------------------------------ *
 * 河道避让
 * ------------------------------------------------------------------ */

const riverSegments = [];
for (const line of GEO.rivers) {
  for (let i = 0; i < line.length - 1; i += 1) riverSegments.push([line[i], line[i + 1]]);
}

/** 点到河道中心线的最短距离（世界单位）。 */
function distanceToRiver(px, pz) {
  let best = Infinity;
  for (const [a, b] of riverSegments) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lengthSq = dx * dx + dz * dz;
    let t = lengthSq === 0 ? 0 : ((px - a[0]) * dx + (pz - a[1]) * dz) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
    if (d < best) best = d;
  }
  return best;
}

const WATER_CLEAR = GEO.riverHalfWidth + 0.15;

/* ------------------------------------------------------------------ *
 * 楼高与分类
 * ------------------------------------------------------------------ */

/**
 * 类型底值（米）。
 *
 * 两轮实测校对：
 * - 第一版取"典型层数 × 3m"并配 0.8–1.3 抖动，结果 30–59 m 区间**一栋都没有**，
 *   全城扁平 10–29 m、只有 6 根地标针——不像城市，像地毯上插了几根钉子。
 * - 原因是 `building=yes`（1765 栋，占多数）是泛化标签，多为 2–4 层老城建筑，
 *   而 `apartments`（653 栋）才是柳州近年 6–20 层的住宅主力。
 * 所以：`yes` 压住不抬（保持老城低矮），住宅/办公类抬高并放宽抖动到 0.75–1.55，
 * 让天际线有中景层次，同时不把哪一栋说成比实际更高。
 */
const TYPE_BASE = {
  apartments: 20,
  residential: 16,
  dormitory: 21,
  hotel: 28,
  office: 26,
  commercial: 14,
  retail: 11,
  hospital: 18,
  school: 15,
  university: 15,
  industrial: 8,
  warehouse: 9,
  garage: 4,
  yes: 12
};

/** 类型码 → 渲染端配色。0 住宅 / 1 商业办公 / 2 工业仓储 / 3 公共。 */
function typeCode(building) {
  if (!building) return 0;
  if (["commercial", "retail", "office", "hotel", "supermarket", "kiosk"].includes(building)) return 1;
  if (["industrial", "warehouse", "manufacture", "factory"].includes(building)) return 2;
  if (["school", "university", "hospital", "civic", "government", "public", "church", "museum"].includes(building)) return 3;
  return 0;
}

function heightOf(tags, id) {
  const raw = tags || {};

  if (raw.height) {
    const meters = parseFloat(String(raw.height).replace(/[^\d.]/g, ""));
    if (Number.isFinite(meters) && meters > 0) return meters;
  }

  if (raw["building:levels"]) {
    const levels = parseFloat(String(raw["building:levels"]).replace(/[^\d.]/g, ""));
    if (Number.isFinite(levels) && levels > 0) return levels * 3.2 + 1.2;
  }

  const base = TYPE_BASE[raw.building] || TYPE_BASE.yes;
  return base * (0.75 + hash01(id) * 0.8);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const wantRefetch = process.argv.includes("--refetch");

console.log(`范围 x ${BOX.minX}..${BOX.maxX} / z ${BOX.minZ}..${BOX.maxZ}`);

/* ---- 建筑 ---- */

const buildingCells = makeCells(2, 3);
const buildingWays = new Map();

for (const cell of buildingCells) {
  const [s, w, n, e] = cell.bbox;
  const query = `[out:json][timeout:120];way["building"](${s},${w},${n},${e});out geom;`;
  const data = await cachedJson(`buildings-${cell.id}.json`, query, `buildings ${cell.id}`, wantRefetch);
  for (const element of data.elements) {
    if (element.type !== "way" || !element.geometry) continue;
    if (!buildingWays.has(element.id)) buildingWays.set(element.id, element);
  }
}

console.log(`建筑 way 合计 ${buildingWays.size}（${buildingCells.length} 格，已按 id 去重）`);

const buildings = [];
let skippedSmall = 0;
let skippedOutside = 0;

for (const element of buildingWays.values()) {
  const footprint = element.geometry.map((p) => project(p.lat, p.lon));
  if (footprint.length < 3) {
    skippedSmall += 1;
    continue;
  }

  const area = polygonArea(footprint);
  if (area < MIN_BUILDING_AREA) {
    skippedSmall += 1;
    continue;
  }

  const rect = minAreaRect(footprint);
  if (!rect) {
    skippedSmall += 1;
    continue;
  }

  // 只保留落在渲染范围内的（矩形中心判定即可，边缘裁掉半栋楼无感）
  if (
    rect.cx < BOX.minX - FETCH_MARGIN ||
    rect.cx > BOX.maxX + FETCH_MARGIN ||
    rect.cz < BOX.minZ - FETCH_MARGIN ||
    rect.cz > BOX.maxZ + FETCH_MARGIN
  ) {
    skippedOutside += 1;
    continue;
  }

  buildings.push([
    rect.cx,
    rect.cz,
    rect.w,
    rect.d,
    rect.rot,
    heightOf(element.tags, element.id),
    typeCode(element.tags && element.tags.building)
  ]);
}

console.log(
  `保留 ${buildings.length} 栋（面积过小剔除 ${skippedSmall}、范围外 ${skippedOutside}）`
);

/* ---- 道路 ---- */

/*
 * 默认不生成：v2.9 起场景不再渲染道路（详情见 docs/3D重构开发计划.md）。
 * 管线保留在这里，加 --with-roads 可重新抓取并写出，避免这份调参过的分级/简化/
 * 江面切段逻辑随删除一起丢掉。
 */
const wantRoads = process.argv.includes("--with-roads");
const roads = wantRoads ? await buildRoads() : [];

async function buildRoads() {

const roadCells = makeCells(2, 3);
const roadWays = new Map();

for (const cell of roadCells) {
  const [s, w, n, e] = cell.bbox;
  const query = `[out:json][timeout:120];way["highway"](${s},${w},${n},${e});out geom;`;
  const data = await cachedJson(`highways-${cell.id}.json`, query, `highways ${cell.id}`, wantRefetch);
  for (const element of data.elements) {
    if (element.type !== "way" || !element.geometry) continue;
    if (!roadWays.has(element.id)) roadWays.set(element.id, element);
  }
}

console.log(`道路 way 合计 ${roadWays.size}`);

const byClass = new Map();
let roadKm = 0;
let skippedStructures = 0;
let skippedClass = 0;
let skippedShort = 0;
let skippedDuplicate = 0;

for (const element of roadWays.values()) {
  const tags = element.tags || {};

  // 桥面已有独立模型；隧道、在建工程画在地面上都是错的
  if (tags.bridge || tags.tunnel || tags.covered || tags.highway === "construction") {
    skippedStructures += 1;
    continue;
  }

  // _link 归到父级
  const rawClass = String(tags.highway || "").replace("_link", "");
  const widthMeters = ROAD_CLASSES[rawClass];
  if (!widthMeters) {
    skippedClass += 1;
    continue;
  }

  const points = element.geometry.map((p) => project(p.lat, p.lon));
  if (points.length < 2) continue;

  // 至少一个点在渲染范围内才保留
  const inside = points.some(
    ([x, z]) =>
      x > BOX.minX - FETCH_MARGIN &&
      x < BOX.maxX + FETCH_MARGIN &&
      z > BOX.minZ - FETCH_MARGIN &&
      z < BOX.maxZ + FETCH_MARGIN
  );
  if (!inside) continue;

  const simplified = simplify(points, ROAD_SIMPLIFY_METERS / METERS_PER_UNIT);
  if (simplified.length < 2) continue;

  // 把横穿江面的路段切掉：OSM 里少数路段没标 bridge 却跨江，
  // 直接画会变成一条压在江面上的深色线。切点两侧各自成段。
  const runs = [];
  let run = [];
  for (const point of simplified) {
    if (distanceToRiver(point[0], point[1]) < WATER_CLEAR) {
      if (run.length >= 2) runs.push(run);
      run = [];
    } else {
      run.push(point);
    }
  }
  if (run.length >= 2) runs.push(run);

  for (const piece of runs) {
    let length = 0;
    for (let i = 1; i < piece.length; i += 1) {
      length += Math.hypot(piece[i][0] - piece[i - 1][0], piece[i][1] - piece[i - 1][1]);
    }
    if (length < MIN_ROAD_LENGTH) {
      skippedShort += 1;
      continue;
    }
    roadKm += length;

    if (!byClass.has(rawClass)) {
      byClass.set(rawClass, { width: widthMeters / METERS_PER_UNIT, lines: [], seen: new Set() });
    }
    const entry = byClass.get(rawClass);

    // 去掉完全重合的重复描线：同一段路被两个 way 各画一遍时，
    // 两条带子在同一高度重叠就是纯粹的深度打架来源。
    const flat = piece.flatMap(([x, z]) => [round2(x), round2(z)]);
    const forward = flat.join(",");
    const backward = reversePairs(flat).join(",");
    const key = forward < backward ? forward : backward;
    if (entry.seen.has(key)) {
      skippedDuplicate += 1;
      continue;
    }
    entry.seen.add(key);
    entry.lines.push(flat);
  }
}

/** [x0,z0,x1,z1,...] → 反向。 */
function reversePairs(flat) {
  const out = [];
  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1]);
  return out;
}



const built = [...byClass.entries()]
    .sort((a, b) => b[1].width - a[1].width)
    .map(([cls, entry]) => ({
      cls,
      width: Math.round(entry.width * 1000) / 1000,
      lines: entry.lines
    }));

  console.log(
    `道路保留 ${built.reduce((sum, r) => sum + r.lines.length, 0)} 条 / ${roadKm.toFixed(1)} 单位（剔除结构物 ${skippedStructures}、不取用的等级 ${skippedClass}、过短残段 ${skippedShort}、重复描线 ${skippedDuplicate}）`
  );

  return built;
}

/* ---- 统计与产物 ---- */

const heights = buildings.map((b) => b[5]);
heights.sort((a, b) => a - b);
const median = heights[Math.floor(heights.length / 2)];
const tallest = buildings.reduce((best, b) => (b[5] > best[5] ? b : best), buildings[0]);

const rects = buildings.map((b) => b[2] * b[3]);
const totalFootprint = rects.reduce((a, b) => a + b, 0);

console.log(
  `楼高 中位 ${median.toFixed(1)} m / 最高 ${tallest[5].toFixed(1)} m / 占地合计 ${(totalFootprint * 10000 / 1e6).toFixed(2)} km²`
);

const byteSize = (text) => (Buffer.byteLength(text, "utf8") / 1024).toFixed(0);

const header = `/**
 * 自动生成，请勿手工编辑——改数据请改 tools/build-city.mjs 后重跑：
 *
 *   node tools/build-city.mjs
 *
 * 数据来源：OpenStreetMap contributors，许可 ODbL-1.0。
 * 投影：等距圆柱，原点 24.342, 109.42；1 世界单位 = 100 米（与 geo.mjs 一致）。
 * 生成日期：${new Date().toISOString().slice(0, 10)}
 *
 * buildings: [x, z, 宽, 深, 旋转, 高(m), 类型码]
 *   - x/z 是**最小外接矩形**的中心（世界单位）
 *   - 宽/深 是外接矩形的两边（世界单位）
 *   - 旋转 直接赋给 three 的 rotation.y（弧度）
 *   - 类型码 0 住宅 / 1 商业办公 / 2 工业仓储 / 3 公共
 *   - 只有 6 栋带 OSM height 标签（地标超高层），其余按类型底值 × id 种子抖动推算
 *
 * roads: 默认不生成（v2.9 起场景不渲染道路）。加 --with-roads 时才附上
 *   { cls, width, lines }，lines 是扁平坐标数组 [x0,z0,x1,z1,...]。
 */
`;

const body = [
  "export const CITY = {",
  `  "source": "OpenStreetMap contributors",`,
  `  "license": "ODbL-1.0",`,
  `  "licenseUrl": "https://www.openstreetmap.org/copyright",`,
  `  "scheme": "equirectangular",`,
  `  "unitMeters": ${METERS_PER_UNIT},`,
  `  "generatedAt": "${new Date().toISOString().slice(0, 10)}",`,
  `  "stats": {`,
  `    "buildings": ${buildings.length},`,
  `    "medianHeight": ${Math.round(median * 10) / 10},`,
  `    "tallest": ${Math.round(tallest[5] * 10) / 10}`,
  `  },`,
  `  "buildings": [`,
  buildings
    .map(
      ([x, z, w, d, rot, h, t]) =>
        `    [${round2(x)},${round2(z)},${round2(w)},${round2(d)},${Math.round(rot * 1000) / 1000},${Math.round(h * 10) / 10},${t}]`
    )
    .join(",\n"),
  `  ],`,
  `  "roads": [`,
  roads
    .map(
      (road) =>
        `    {\n      "cls": "${road.cls}",\n      "width": ${road.width},\n      "lines": [\n` +
        road.lines.map((line) => `        [${line.join(",")}]`).join(",\n") +
        `\n      ]\n    }`
    )
    .join(",\n"),
  `  ]`,
  `};`,
  ``,
  `export default CITY;`,
  ``
].join("\n");

fs.writeFileSync(OUT_FILE, header + body, "utf8");

console.log(
  `\n已写出 ${path.relative(ROOT, OUT_FILE)}：${byteSize(header + body)} KB` +
    `（建筑 ${buildings.length} 栋${roads.length ? "，道路 " + roads.reduce((sum, r) => sum + r.lines.length, 0) + " 条" : ""}）`
);
