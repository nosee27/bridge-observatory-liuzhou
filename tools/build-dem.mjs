/**
 * 地形管线：DEM 瓦片 → 高程网格 → app3d/terrain.mjs
 *
 *   node tools/build-dem.mjs              # 有缓存则跳过下载
 *   node tools/build-dem.mjs --refetch    # 忽略缓存重新下载瓦片
 *   node tools/build-dem.mjs --preview    # 额外打印 ASCII 高程图
 *
 * 数据来源：AWS Open Data Terrain Tiles（terrarium 编码，源自 SRTM/NED 等公共数据）
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *   编码：elev(m) = R*256 + G + B/256 - 32768
 *
 * 为什么不像 build-geo.mjs 那样用 Overpass：山体高程 OSM 里根本没有
 * （`natural=peak` 在柳州只有 27 个点，且缺鱼峰山、马鞍山），必须用 DEM。
 *
 * 产物只存**未夸张的相对高程**（相对盆底基准，单位米，精度 0.1 m），
 * 竖向夸张在渲染端施加——这样改夸张倍率不需要重跑管线。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { GEO } from "../app3d/geo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE_DIR = path.join(HERE, ".cache", "dem");
const OUT_FILE = path.join(ROOT, "app3d", "terrain.mjs");

const UA = "bridge-observatory-liuzhou/1.0 (educational static site)";

/** 与 build-geo.mjs 保持同一套投影，否则地形和河道对不上。 */
const ORIGIN = { lat: 24.342, lon: 109.42 };
const METERS_PER_UNIT = 100;

/** terrarium 瓦片层级：z13 在柳州纬度约 27 m/像素，1 单位=100 m 下约 3.7 采样/单位。 */
const TILE_Z = 13;

/** 网格步长（世界单位）。0.5 单位 = 50 m，孤峰宽 300 m 有 6 个采样，够出剪影。 */
const STEP = 0.5;

/**
 * 地形网格覆盖范围，比取景窗口（x -34..20 / z -52..44）四周各多留 14 单位以上。
 *
 * 为什么要外扩这么多——两条硬约束：
 * 1. 外圈要做淡出斜坡，把边界压回 0 才能和外接平地裙边无缝衔接。
 *    若网格贴着窗口做，淡出带会直接削进画面（鱼峰山在 z=43.25，距窗口南界仅 0.75 单位）。
 * 2. 柳州四周都是山：实测 z=-45 剖面东向 7 km 外仍有 160 m 山体，
 *    北面 9 km、西面 7 km 亦如此。也就是说"缓坡收尾"必须发生在画面之外足够远处，
 *    才不会被看成一条被人为切断的山脊。
 */
const BOX = { minX: -48, maxX: 36, minZ: -68, maxZ: 58 };

/**
 * 边缘淡出带宽度（世界单位）。
 * 8 单位 = 800 m：一座 280 m 的山在 800 m 内降到平地 ≈ 19°，读起来就是正常的山脚余脉；
 * 之前取 3 单位时是 54°，看起来像被一刀切平。
 */
const EDGE_TAPER = 8;

/**
 * 河道压平：水面是贴在 y≈0 的 polygonOffset 贴花（v2.2），
 * 地形如果在河道处抬起就会把水面戳穿。所以：
 *   距江心线 < 1.7 单位 → 强制 0（水面半宽 1.5，留 0.2 余量）
 *   1.7–2.6 单位 → smoothstep 过渡回自然高程（形成江岸）
 *   2.6 以外 → 原始高程
 * 上限 2.6 是被实测约束的：河南峰距江心 3.75、蟠龙山 4.20，
 * 过渡带再宽就会开始削这两座贴江的孤峰。
 */
const RIVER_FLAT_R = 1.7;
const RIVER_BLEND_R = 2.6;

/* ------------------------------------------------------------------ *
 * 瓦片与解码
 * ------------------------------------------------------------------ */

function unproject(x, z) {
  const R = 6378137;
  const lon =
    ORIGIN.lon + (x * METERS_PER_UNIT * 180) / (Math.PI * R * Math.cos((ORIGIN.lat * Math.PI) / 180));
  const lat = ORIGIN.lat + (-z * METERS_PER_UNIT * 180) / (Math.PI * R);
  return { lat, lon };
}

function tileOf(lat, lon) {
  const n = 2 ** TILE_Z;
  const px = ((lon + 180) / 360) * n * 256;
  const s = Math.sin((lat * Math.PI) / 180);
  const py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256;
  return { tx: Math.floor(px / 256), ty: Math.floor(py / 256), px, py };
}

/** 手写 PNG 解码：只处理 terrarium 用到的 8 位 RGB/RGBA，不支持调色板与隔行。 */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const chunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      chunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`unsupported PNG color type ${colorType}`);
  }

  const bpp = colorType === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  // 还原 PNG 五种行滤波
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[dst + x - stride] : 0;
      const upLeft = y > 0 && x >= bpp ? out[dst + x - bpp - stride] : 0;
      let restored;
      if (filter === 0) {
        restored = value;
      } else if (filter === 1) {
        restored = value + left;
      } else if (filter === 2) {
        restored = value + up;
      } else if (filter === 3) {
        restored = value + ((left + up) >> 1);
      } else {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        restored = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[dst + x] = restored & 0xff;
    }
  }

  return { width, height, bpp, data: out };
}

const tiles = new Map();

async function loadTile(tx, ty, refetch) {
  const key = `${tx}_${ty}`;
  if (tiles.has(key)) return tiles.get(key);

  const cached = path.join(CACHE_DIR, `${TILE_Z}_${key}.png`);
  let buffer = null;

  if (!refetch && fs.existsSync(cached)) {
    buffer = fs.readFileSync(cached);
  } else {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TILE_Z}/${tx}/${ty}.png`;
    const response = await fetch(url, { headers: { "User-Agent": UA } });
    if (!response.ok) throw new Error(`tile ${key} -> HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cached, buffer);
  }

  const image = decodePng(buffer);
  tiles.set(key, image);
  return image;
}

/** 双线性采样高程（米）。采样点落在未下载的瓦片上时按需补下。 */
async function elevationAt(lat, lon, refetch) {
  const t = tileOf(lat, lon);
  const image = await loadTile(t.tx, t.ty, refetch);
  const fx = t.px - t.tx * 256 - 0.5;
  const fy = t.py - t.ty * 256 - 0.5;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;

  const sample = (x, y) => {
    const cx = Math.max(0, Math.min(image.width - 1, x));
    const cy = Math.max(0, Math.min(image.height - 1, y));
    const o = (cy * image.width + cx) * image.bpp;
    return image.data[o] * 256 + image.data[o + 1] + image.data[o + 2] / 256 - 32768;
  };

  const top = sample(x0, y0) * (1 - ax) + sample(x0 + 1, y0) * ax;
  const bottom = sample(x0, y0 + 1) * (1 - ax) + sample(x0 + 1, y0 + 1) * ax;
  return top * (1 - ay) + bottom * ay;
}

/* ------------------------------------------------------------------ *
 * 距离场
 * ------------------------------------------------------------------ */

const riverSegments = [];
for (const line of GEO.rivers) {
  for (let i = 0; i < line.length - 1; i += 1) {
    riverSegments.push([line[i], line[i + 1]]);
  }
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

const smoothstep = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const wantRefetch = process.argv.includes("--refetch");
const wantPreview = process.argv.includes("--preview");

const cols = Math.round((BOX.maxX - BOX.minX) / STEP) + 1;
const rows = Math.round((BOX.maxZ - BOX.minZ) / STEP) + 1;

console.log(`网格 ${cols} × ${rows} = ${cols * rows} 点，步长 ${STEP} 单位`);

// 1) 全网格取原始高程（米）与到江心的距离
const count = cols * rows;
const rawElevation = new Float32Array(count);
const riverDistance = new Float32Array(count);

for (let r = 0; r < rows; r += 1) {
  const z = BOX.minZ + r * STEP;
  for (let c = 0; c < cols; c += 1) {
    const x = BOX.minX + c * STEP;
    const { lat, lon } = unproject(x, z);
    const index = r * cols + c;
    rawElevation[index] = await elevationAt(lat, lon, wantRefetch);
    riverDistance[index] = distanceToRiver(x, z);
  }
}

// 2) 基准高程 = **陆地**高程中位数
//
// 踩过的坑：最初按 02 报告取"沿江心线取样的中位数"，算出来只有 64.7 m，
// 而两岸城区实测是 97–100 m。原因是 SRTM 系 DEM 在城市水面上读数系统性偏低
// （江心 62–70 m，城区 97–100 m，差约 35 m），拿它当基准会把整个盆底
// 抬成 30 米的台地，所有建筑、桥端全部埋进地形里。
// 盆地平原是网格中的绝对多数，取"远离河道"的点位中位数即可稳定落在 ~96 m。
const landSamples = [];
for (let i = 0; i < count; i += 1) {
  if (riverDistance[i] > RIVER_BLEND_R) landSamples.push(rawElevation[i]);
}
landSamples.sort((a, b) => a - b);
const base = Math.round(landSamples[Math.floor(landSamples.length / 2)] * 10) / 10;
console.log(
  `陆地点位 ${landSamples.length}（${((landSamples.length / count) * 100).toFixed(1)}%），基准高程（中位数）${base} m`
);

// 3) 相对高程 → 河道压平 → 边缘淡出 → 量化
const heights = new Uint16Array(count);
let zeroCount = 0;
let maxRel = 0;

for (let r = 0; r < rows; r += 1) {
  const z = BOX.minZ + r * STEP;
  for (let c = 0; c < cols; c += 1) {
    const x = BOX.minX + c * STEP;
    const index = r * cols + c;

    const relative = Math.max(0, rawElevation[index] - base);

    const dRiver = riverDistance[index];
    const riverFactor =
      dRiver <= RIVER_FLAT_R
        ? 0
        : dRiver >= RIVER_BLEND_R
          ? 1
          : smoothstep((dRiver - RIVER_FLAT_R) / (RIVER_BLEND_R - RIVER_FLAT_R));

    const edgeDistance = Math.min(
      x - BOX.minX,
      BOX.maxX - x,
      z - BOX.minZ,
      BOX.maxZ - z
    );
    const edgeFactor = smoothstep(edgeDistance / EDGE_TAPER);

    const value = relative * riverFactor * edgeFactor;
    if (value === 0) zeroCount += 1;
    if (value > maxRel) maxRel = value;

    // 0.1 m 量化
    heights[index] = Math.min(65535, Math.round(value * 10));
  }
}

console.log(
  `压平/淡出为 0 的格点 ${zeroCount}（${((zeroCount / heights.length) * 100).toFixed(1)}%），最高相对高程 ${maxRel.toFixed(1)} m`
);

// 3) 关键点位自检
const probes = [
  ["鱼峰山", -10.3, 43.4],
  ["蟠龙山", 2.2, 30.1],
  ["柳侯公园山", 5.7, 24.5],
  ["河南峰", -4.1, 37.3],
  ["东岸峰", 18.1, -5.6]
];

console.log("\n点位自检（相对高程 → 渲染高度，夸张 ×3）：");
for (const [name, x, z] of probes) {
  const c = Math.round((x - BOX.minX) / STEP);
  const r = Math.round((z - BOX.minZ) / STEP);
  let best = 0;
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const rr = Math.min(rows - 1, Math.max(0, r + dr));
      const cc = Math.min(cols - 1, Math.max(0, c + dc));
      best = Math.max(best, heights[rr * cols + cc] / 10);
    }
  }
  console.log(
    `  ${name.padEnd(7, "　")} ${best.toFixed(1).padStart(6)} m  →  ${((best * 3) / METERS_PER_UNIT)
      .toFixed(2)
      .padStart(5)} 单位`
  );
}

if (wantPreview) {
  console.log("\nASCII 高程图（北在上；每格 4×4 采样，字符 = 相对高程档位）：");
  const ramp = " .:-=+*#%@";
  const stepR = 4;
  const stepC = 4;
  for (let r = 0; r < rows; r += stepR) {
    let line = "";
    for (let c = 0; c < cols; c += stepC) {
      const v = heights[r * cols + c] / 10;
      const idx = Math.min(ramp.length - 1, Math.floor((v / Math.max(maxRel, 1)) * ramp.length));
      line += ramp[idx];
    }
    console.log(line);
  }
}

// 4) 产物
const byteLength = heights.length * 2;
const base64 = Buffer.from(heights.buffer, heights.byteOffset, byteLength).toString("base64");

const header = `/**
 * 自动生成，请勿手工编辑——改数据请改 tools/build-dem.mjs 后重跑：
 *
 *   node tools/build-dem.mjs --preview
 *
 * 数据来源与署名（数据方要求，勿删）：
 *   "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data
 *    courtesy of the U.S. Geological Survey."
 *   瓦片打包：Mapzen Joerd（MIT）；分发：AWS Open Data Terrain Tiles。
 *   注册页 https://registry.opendata.aws/terrain-tiles/ → 署名条款见
 *   https://github.com/tilezen/joerd/blob/master/docs/attribution.md
 *
 * 瓦片 ${TILE_Z} 级，柳州纬度约 27 m/像素；此处已双线性重采样到 ${STEP} 单位（${STEP * METERS_PER_UNIT} m）网格。
 * 高程为**相对盆底基准 ${base} m 的相对高程**，单位米，精度 0.1 m（Uint16 小端）。
 * 已施加：河道压平（距江心线 < ${RIVER_FLAT_R} 单位归零，${RIVER_BLEND_R} 单位外恢复原有起伏）、
 *         外圈 ${EDGE_TAPER} 单位淡出到 0（与平地裙边无缝衔接）。
 * 竖向夸张不在此处施加，由渲染端乘系数。
 * 生成日期：${new Date().toISOString().slice(0, 10)}
 */
`;

const body = `export const TERRAIN = {
  "source": "AWS Terrain Tiles (terrarium) / SRTM",
  "tileZoom": ${TILE_Z},
  "step": ${STEP},
  "cols": ${cols},
  "rows": ${rows},
  "minX": ${BOX.minX},
  "maxX": ${BOX.maxX},
  "minZ": ${BOX.minZ},
  "maxZ": ${BOX.maxZ},
  "base": ${base},
  "unitMeters": ${METERS_PER_UNIT},
  "data": "${base64}"
};

export default TERRAIN;
`;

fs.writeFileSync(OUT_FILE, header + body, "utf8");

const sizeKb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
console.log(`\n已写出 ${path.relative(ROOT, OUT_FILE)}：${sizeKb} KB（base64 ${(base64.length / 1024).toFixed(1)} KB）`);
console.log(`瓦片缓存：${tiles.size} 块（${path.relative(ROOT, CACHE_DIR)}）`);
console.log(`三角面：${(cols - 1) * (rows - 1) * 2} 个`);
