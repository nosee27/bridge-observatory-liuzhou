/**
 * 真实地理数据管线（离线一次性运行，产物提交进仓库）。
 *
 *   node tools/build-geo.mjs                    # 取数（有缓存则跳过）+ 生成 app3d/geo.mjs
 *   node tools/build-geo.mjs --preview          # 额外打印 ASCII 河形预览
 *   node tools/build-geo.mjs --refetch          # 忽略缓存重新取数
 *   node tools/build-geo.mjs --crop=-34,20,-52,44 --preview   # 临时改取景窗口
 *
 * 数据来源：OpenStreetMap（ODbL 1.0，需署名 "© OpenStreetMap contributors"）。
 *
 * 为什么用 Node：本机 Schannel TLS 已坏（curl / Invoke-WebRequest 报
 * SEC_E_NO_CREDENTIALS），而 Node 自带 OpenSSL，fetch 可直接连通。
 * 详见技能 public-geodata-fetch。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE_DIR = path.join(HERE, ".cache");
const OUT_FILE = path.join(ROOT, "app3d", "geo.mjs");

const UA = "bridge-observatory-liuzhou/1.0 (educational static site)";

/**
 * 取数范围：覆盖五桥与壶城弯的核心区，并向东扩到足以包含柳江东侧的回弯。
 * 东边界必须够远——柳江在城东绕出去再回来，那段连接河道在 109.50 以东，
 * 少了它，河道会被切成两截，画面右下角就会出现一截悬空的短河。
 */
const FETCH_BBOX = "24.22,109.26,24.47,109.63";

/** 只保留包含该名称河段的连通分量，避免把竹鹅溪等支流按同等宽度画出来。 */
const RIVER_NAME = "柳江";

/** 场景原点（等距投影中心）。 */
const ORIGIN = { lat: 24.342, lon: 109.42 };

/** 1 世界单位 = 100 米。 */
const METERS_PER_UNIT = 100;

/** 河道简化容差（米）。12 m 在 1:100 场景里约 0.12 单位，弯道足够顺滑。 */
const RIVER_TOLERANCE_M = 12;

/** 河面半宽（米）——OSM 的 waterway=river 只有中心线，没有宽度。 */
const RIVER_HALF_WIDTH_M = 150;

/**
 * 场景取景窗口（世界单位）。取五桥聚集的城南江段：
 * 既保住壶城发卡弯的辨识度，又不至于让桥缩成像素。
 */
const SCENE_WINDOW = {
  minX: -34,
  maxX: 20,
  minZ: -52,
  maxZ: 44
};

/**
 * 判定「这条河道与取景窗口相关」的余量。
 * 河道不再逐点裁剪（见 selectByWindow），这个值只用来决定整条折线留不留。
 */
const WINDOW_TOUCH_MARGIN = 26;

/** OSM 桥名 → 项目桥 id。注意柳州在 OSM 里登的是「文昌桥」，不是「文昌大桥」。 */
const BRIDGE_NAME_TO_ID = new Map([
  ["柳江大桥", "liujiang"],
  ["文惠桥", "wenhui"],
  ["文昌桥", "wenchang"],
  ["白沙大桥", "baisha"],
  ["凤凰岭大桥", "fenghuangling"]
]);

/* ------------------------------------------------------------------ *
 * 取数
 * ------------------------------------------------------------------ */

const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
          console.log(`[${label}] ${server.split("/")[2]} ok ${text.length} bytes`);
          return JSON.parse(text);
        }
        console.log(`[${label}] ${server.split("/")[2]} status=${response.status} retry`);
      } catch (error) {
        console.log(`[${label}] ${server.split("/")[2]} ${error.message}`);
      }
      await sleep(4000 * (attempt + 1));
    }
  }
  throw new Error(`[${label}] all mirrors failed`);
}

async function cached(name, buildQuery, refetch) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, name);
  if (!refetch && fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    if (text.includes('"elements"')) {
      console.log(`[${name}] cache hit`);
      return JSON.parse(text);
    }
  }
  const data = await overpass(buildQuery(), name);
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
  return data;
}

/* ------------------------------------------------------------------ *
 * 几何工具
 * ------------------------------------------------------------------ */

function project(lat, lon) {
  const R = 6378137;
  const x = (((lon - ORIGIN.lon) * Math.PI) / 180) * R * Math.cos((ORIGIN.lat * Math.PI) / 180);
  const y = (((lat - ORIGIN.lat) * Math.PI) / 180) * R;
  return { x: x / METERS_PER_UNIT, z: -y / METERS_PER_UNIT };
}

function perpendicularDistance(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(point.x - start.x, point.z - start.z);
  let t = ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (start.x + t * dx), point.z - (start.z + t * dz));
}

/** Douglas–Peucker（容差已折算成世界单位）。 */
function simplify(points, tolerance) {
  if (points.length <= 2) return points.slice();
  let maxDistance = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = perpendicularDistance(points[i], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  if (maxDistance <= tolerance) return [first, last];
  const left = simplify(points.slice(0, index + 1), tolerance);
  const right = simplify(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return total;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * 河道：按共享节点拼接成若干条连续折线
 * ------------------------------------------------------------------ */

function collectWays(data) {
  const coords = new Map();
  const ways = [];
  for (const element of data.elements) {
    if (!element.geometry || !element.nodes) continue;
    element.nodes.forEach((id, index) => {
      const point = element.geometry[index];
      if (point) coords.set(id, point);
    });
    ways.push(element);
  }
  return { coords, ways };
}

/** 按共享端点节点把 way 划分成互不相连的分量（并查集）。 */
function componentsOf(ways) {
  const byNode = new Map();
  ways.forEach((way, index) => {
    for (const id of new Set([way.nodes[0], way.nodes[way.nodes.length - 1]])) {
      if (!byNode.has(id)) byNode.set(id, []);
      byNode.get(id).push(index);
    }
  });

  const parent = ways.map((_, index) => index);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const list of byNode.values()) {
    for (let i = 1; i < list.length; i += 1) union(list[0], list[i]);
  }

  const groups = new Map();
  ways.forEach((_, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(index);
  });
  return [...groups.values()];
}

/**
 * 沿共享端点把一条分量内的 way 串成折线。
 *
 * 汇流处（degree ≥ 3）不能盲取第一个候选：柳江与洛清江、竹鹅溪的夹角都很大，
 * 顺着最"直"的那条走才不会把支流吞进主河道。转角过陡时宁可断开。
 */
function stitchWays(ways, coords) {
  const adjacency = new Map();
  const used = new Set();
  const chains = [];

  ways.forEach((way, index) => {
    for (const key of new Set([way.nodes[0], way.nodes[way.nodes.length - 1]])) {
      if (!adjacency.has(key)) adjacency.set(key, []);
      adjacency.get(key).push(index);
    }
  });

  function toLatLon(ids) {
    const out = [];
    for (const id of ids) {
      const point = coords.get(id);
      if (!point) continue;
      const last = out[out.length - 1];
      if (last && last.lat === point.lat && last.lon === point.lon) continue;
      out.push({ lat: point.lat, lon: point.lon });
    }
    return out;
  }

  const unit = (fromId, toId) => {
    const a = coords.get(fromId);
    const b = coords.get(toId);
    if (!a || !b) return null;
    const dx = b.lon - a.lon;
    const dy = b.lat - a.lat;
    const length = Math.hypot(dx, dy);
    return length ? { x: dx / length, y: dy / length } : null;
  };

  const pick = (candidates, incoming, afterId) => {
    let best = null;
    let bestScore = -Infinity;
    for (const index of candidates) {
      const way = ways[index];
      const forward = way.nodes[0] === afterId;
      const nextId = forward ? way.nodes[1] : way.nodes[way.nodes.length - 2];
      const outgoing = unit(afterId, nextId);
      if (!outgoing) continue;
      const score = incoming
        ? incoming.x * outgoing.x + incoming.y * outgoing.y
        : 1;
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    if (best === null) return null;
    // 没有岔路就一定是同一条河，无论弯多急都得接上——壶城发卡弯本来就有近 90° 的折角
    if (candidates.length === 1 || !incoming) return best;
    // 有岔路时只走最"直"的那条，转角过陡（约 78° 以上）视为支流汇入，不并进主河道
    return bestScore >= 0.2 ? best : null;
  };

  for (let index = 0; index < ways.length; index += 1) {
    if (used.has(index)) continue;
    used.add(index);
    const way = ways[index];
    const closed = way.nodes[0] === way.nodes[way.nodes.length - 1];
    let chain = way.nodes.slice();

    if (!closed) {
      for (;;) {
        const tail = chain[chain.length - 1];
        const previous = chain[chain.length - 2];
        const candidates = (adjacency.get(tail) || []).filter((i) => !used.has(i));
        if (!candidates.length) break;
        const next = pick(candidates, unit(previous, tail), tail);
        if (next === null) break;
        used.add(next);
        const node = ways[next];
        const forward = node.nodes[0] === tail;
        const seq = forward ? node.nodes.slice(1) : node.nodes.slice(0, -1).reverse();
        chain = chain.concat(seq);
      }
      for (;;) {
        const head = chain[0];
        const after = chain[1];
        const candidates = (adjacency.get(head) || []).filter((i) => !used.has(i));
        if (!candidates.length) break;
        const next = pick(candidates, unit(after, head), head);
        if (next === null) break;
        used.add(next);
        const node = ways[next];
        const forward = node.nodes[node.nodes.length - 1] === head;
        const seq = forward ? node.nodes.slice(0, -1) : node.nodes.slice(1).reverse();
        chain = seq.concat(chain);
      }
    }

    const latlon = toLatLon(chain);
    if (latlon.length >= 2) chains.push(latlon);
  }

  return chains;
}

/**
 * 只拼接包含「柳江」河段的分量。
 *
 * 本次取数范围内还有竹鹅溪、洛清江等支流；它们与主河道共用同一宽度参数，
 * 一起画出来会失真，因此整条剔除——先由名称圈定分量，再由窗口筛选。
 */
function stitchRivers(data, win) {
  const { coords, ways } = collectWays(data);
  const groups = componentsOf(ways);
  const kept = groups.filter((group) =>
    group.some((index) => (ways[index].tags || {}).name === RIVER_NAME)
  );
  console.log(
    `river ways: ${ways.length}, components: ${groups.length}, ` +
      `${RIVER_NAME} components: ${kept.length}`
  );

  // 一条河在取数范围里可能伸出去很远，判断"哪条分支才是画面里这条河"要看窗口内的长度，
  // 不能看总长：城北那段延伸有 15 km，比穿过市区的这一段长得多。
  const insideLength = (chain) => {
    let total = 0;
    for (let i = 1; i < chain.length; i += 1) {
      const a = project(chain[i - 1].lat, chain[i - 1].lon);
      const b = project(chain[i].lat, chain[i].lon);
      const x = (a.x + b.x) / 2;
      const z = (a.z + b.z) / 2;
      const inWindow =
        x >= win.minX - WINDOW_TOUCH_MARGIN &&
        x <= win.maxX + WINDOW_TOUCH_MARGIN &&
        z >= win.minZ - WINDOW_TOUCH_MARGIN &&
        z <= win.maxZ + WINDOW_TOUCH_MARGIN;
      if (inWindow) total += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return total;
  };

  const chains = [];
  for (const group of kept) {
    const stitched = stitchWays(group.map((i) => ways[i]), coords);
    if (stitched.length > 1) {
      // 河中岛（如萝卜洲）会把河道分成两条汊道，形成 Y 形岔路。
      // 这个细节层次下只保留窗口内最长的一条中心线，否则会画出两条平行且断头的水带。
      stitched.sort((a, b) => insideLength(b) - insideLength(a));
      console.log(
        `  component has ${stitched.length} branches, inside-window length ` +
          `${stitched.map((c) => round(insideLength(c))).join(", ")} -> keep the longest`
      );
    }
    if (stitched.length) chains.push(stitched[0]);
  }
  return chains;
}

function cleanRivers(chains) {
  const tolerance = RIVER_TOLERANCE_M / METERS_PER_UNIT;
  const result = [];
  for (const latlon of chains) {
    const projected = latlon.map((p) => project(p.lat, p.lon));
    const simplified = simplify(projected, tolerance);
    if (polylineLength(simplified) < 0.8) continue;
    result.push(simplified.map((p) => [round(p.x), round(p.z)]));
  }
  result.sort(
    (a, b) =>
      polylineLength(b.map(([x, z]) => ({ x, z }))) -
      polylineLength(a.map(([x, z]) => ({ x, z })))
  );
  return result;
}

/* ------------------------------------------------------------------ *
 * 裁剪与端点延伸
 * ------------------------------------------------------------------ */

/**
 * 只保留真正进入取景窗口的折线，整条保留、不在中途切断。
 *
 * 早先按「窗口 + margin」逐点裁剪，断口恰好落在相机可视范围（默认视角能看到
 * 窗口外约 75 单位）之内，画面边缘就会出现凭空断头的河道。整条保留后，
 * 河道必然从画面外流进、再流出画面外。
 */
function selectByWindow(lines, win, margin) {
  return lines.filter((line) =>
    line.some(
      ([x, z]) =>
        x >= win.minX - margin &&
        x <= win.maxX + margin &&
        z >= win.minZ - margin &&
        z <= win.maxZ + margin
    )
  );
}

/**
 * 两端各沿切向延伸一段。作用有二：
 * 1) 让水面流到窗口外，不出现凭空断口；
 * 2) 掩盖 OSM 在汇流处把河切成多条 way 造成的接缝。
 */
function extendEnds(line, distance) {
  if (line.length < 2) return line;
  const first = line[0];
  const second = line[1];
  const last = line[line.length - 1];
  const beforeLast = line[line.length - 2];

  const extendFrom = (from, towards) => {
    const dx = from[0] - towards[0];
    const dz = from[1] - towards[1];
    const length = Math.hypot(dx, dz) || 1;
    return [round(from[0] + (dx / length) * distance), round(from[1] + (dz / length) * distance)];
  };

  return [extendFrom(first, second), ...line, extendFrom(last, beforeLast)];
}

/* ------------------------------------------------------------------ *
 * 桥梁：从桥面多边形算中心、轴向、长宽
 * ------------------------------------------------------------------ */

function analyseBridge(element) {
  const points = element.geometry.filter(Boolean).map((p) => project(p.lat, p.lon));
  if (points.length < 3) return null;

  const centroid = points.reduce(
    (acc, p) => ({ x: acc.x + p.x / points.length, z: acc.z + p.z / points.length }),
    { x: 0, z: 0 }
  );

  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const p of points) {
    const dx = p.x - centroid.x;
    const dz = p.z - centroid.z;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const axis = { x: Math.cos(theta), z: Math.sin(theta) };

  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (const p of points) {
    const dx = p.x - centroid.x;
    const dz = p.z - centroid.z;
    const along = dx * axis.x + dz * axis.z;
    const across = -dx * axis.z + dz * axis.x;
    minA = Math.min(minA, along);
    maxA = Math.max(maxA, along);
    minB = Math.min(minB, across);
    maxB = Math.max(maxB, across);
  }

  return {
    x: round(centroid.x),
    z: round(centroid.z),
    // three.js 绕 Y 轴旋 theta 时，局部 +X 指向 (cos, -sin)，故取负
    angle: round(-theta),
    length: round(maxA - minA),
    width: round(maxB - minB)
  };
}

/* ------------------------------------------------------------------ *
 * ASCII 预览
 * ------------------------------------------------------------------ */

function preview(rivers, bridges, win) {
  const COLS = 96;
  const ROWS = 40;
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(" "));

  const toCell = (x, z) => ({
    col: Math.round(((x - win.minX) / (win.maxX - win.minX)) * (COLS - 1)),
    row: Math.round(((win.maxZ - z) / (win.maxZ - win.minZ)) * (ROWS - 1))
  });

  const clamp = (cell) => ({
    col: Math.min(COLS - 1, Math.max(0, cell.col)),
    row: Math.min(ROWS - 1, Math.max(0, cell.row))
  });
  const inside = (cell) => cell.col >= 0 && cell.col < COLS && cell.row >= 0 && cell.row < ROWS;

  for (const line of rivers) {
    let previous = null;
    for (const [x, z] of line) {
      const cell = toCell(x, z);
      // 两端都在画外的线段不画，否则会在图里留下一条横穿画面的假线
      if (previous && (inside(previous) || inside(cell))) {
        const from = clamp(previous);
        const to = clamp(cell);
        const steps = Math.max(Math.abs(to.col - from.col), Math.abs(to.row - from.row));
        for (let s = 0; s <= steps; s += 1) {
          const t = steps === 0 ? 0 : s / steps;
          const col = Math.round(from.col + (to.col - from.col) * t);
          const row = Math.round(from.row + (to.row - from.row) * t);
          if (grid[row] && grid[row][col] !== undefined) grid[row][col] = "#";
        }
      }
      previous = cell;
    }
  }

  for (const bridge of bridges) {
    const cell = toCell(bridge.x, bridge.z);
    if (grid[cell.row] && grid[cell.row][cell.col] !== undefined) {
      grid[cell.row][cell.col] = "O";
    }
  }

  console.log("");
  console.log(`window: x ${win.minX}..${win.maxX}  z ${win.minZ}..${win.maxZ} (units, north up)`);
  console.log("+" + "-".repeat(COLS) + "+");
  for (const row of grid) console.log("|" + row.join("") + "|");
  console.log("+" + "-".repeat(COLS) + "+");
  for (const bridge of bridges) {
    console.log(
      `  ${bridge.id.padEnd(14)} x=${String(bridge.x).padStart(7)} z=${String(bridge.z).padStart(7)}` +
        ` angle=${String(bridge.angle).padStart(6)} length=${bridge.length} width=${bridge.width}`
    );
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const refetch = argv.includes("--refetch");
const wantPreview = argv.includes("--preview");

const cropArg = argv.find((arg) => arg.startsWith("--crop="));
const window = cropArg
  ? (() => {
      const [minX, maxX, minZ, maxZ] = cropArg.slice("--crop=".length).split(",").map(Number);
      if ([minX, maxX, minZ, maxZ].some((value) => !Number.isFinite(value))) {
        throw new Error("--crop 需要四个数字：minX,maxX,minZ,maxZ");
      }
      return { minX, maxX, minZ, maxZ };
    })()
  : SCENE_WINDOW;

// 河道取全部 river 而不只是 name=柳江：柳江东侧回弯处有两段未命名的连接河道，
// 只按名称查会把主河道切成两截。拼接后再按名称圈定分量、按窗口筛选。
const riversRaw = await cached(
  "rivers.json",
  () => `[out:json][timeout:180];way["waterway"="river"](${FETCH_BBOX});out body geom;`,
  refetch
);

const bridgesRaw = await cached(
  "bridges.json",
  () => `[out:json][timeout:180];way["man_made"="bridge"](${FETCH_BBOX});out body geom;`,
  refetch
);

const chains = stitchRivers(riversRaw, window);
const rawNodes = chains.reduce((n, c) => n + c.length, 0);
console.log(`stitched chains: ${chains.length}, raw nodes: ${rawNodes}`);

const rivers = cleanRivers(chains);
console.log(
  `simplified polylines: ${rivers.length}, points: ${rivers.reduce((n, r) => n + r.length, 0)}`
);

const bridges = [];
for (const element of bridgesRaw.elements) {
  const name = element.tags && element.tags.name;
  if (!name) continue;
  const id = BRIDGE_NAME_TO_ID.get(name);
  if (!id) continue;
  if (bridges.some((b) => b.id === id)) continue;
  const analysis = analyseBridge(element);
  if (!analysis) continue;
  bridges.push({ id, osmName: name, osmId: `way/${element.id}`, ...analysis });
}
bridges.sort((a, b) => a.z - b.z);
console.log(`bridges: ${bridges.map((b) => `${b.id}(${b.length}x${b.width})`).join(", ")}`);

const xs = [];
const zs = [];
for (const line of rivers) for (const [x, z] of line) { xs.push(x); zs.push(z); }
const fullExtent = {
  minX: round(Math.min(...xs)),
  maxX: round(Math.max(...xs)),
  minZ: round(Math.min(...zs)),
  maxZ: round(Math.max(...zs))
};
console.log(
  `full river extent: x ${fullExtent.minX}..${fullExtent.maxX}  z ${fullExtent.minZ}..${fullExtent.maxZ} ` +
    `(${round(((fullExtent.maxX - fullExtent.minX) * METERS_PER_UNIT) / 1000)} km x ` +
    `${round(((fullExtent.maxZ - fullExtent.minZ) * METERS_PER_UNIT) / 1000)} km)`
);

const selected = selectByWindow(rivers, window, WINDOW_TOUCH_MARGIN).map((line) =>
  extendEnds(line, round(RIVER_HALF_WIDTH_M / METERS_PER_UNIT) * 1.6)
);
console.log(
  `window ${window.minX}..${window.maxX} x ${window.minZ}..${window.maxZ} ` +
    `(${round(((window.maxX - window.minX) * METERS_PER_UNIT) / 1000)} km x ` +
    `${round(((window.maxZ - window.minZ) * METERS_PER_UNIT) / 1000)} km) -> ` +
    `${selected.length} polyline(s), ${selected.reduce((n, r) => n + r.length, 0)} points`
);

// 不变量：任何折线端点都不应落在相机的可视范围内，否则画面里会出现断头的河道。
const VIEW_REACH = 80;
for (const line of selected) {
  for (const [label, point] of [
    ["head", line[0]],
    ["tail", line[line.length - 1]]
  ]) {
    const nearWindow =
      point[0] >= window.minX - VIEW_REACH &&
      point[0] <= window.maxX + VIEW_REACH &&
      point[1] >= window.minZ - VIEW_REACH &&
      point[1] <= window.maxZ + VIEW_REACH;
    if (nearWindow) {
      console.warn(
        `  warning: ${label} 端点 (${point[0]}, ${point[1]}) 距窗口不足 ${VIEW_REACH} 单位，可能露出断口`
      );
    }
  }
}

const inWindow = bridges.filter(
  (b) =>
    b.x >= window.minX &&
    b.x <= window.maxX &&
    b.z >= window.minZ &&
    b.z <= window.maxZ
);
console.log(`bridges inside window: ${inWindow.length}/${bridges.length}`);

if (wantPreview) {
  preview(selected, inWindow, window);
}

const payload = {
  source: "OpenStreetMap contributors",
  license: "ODbL-1.0",
  licenseUrl: "https://www.openstreetmap.org/copyright",
  generatedAt: new Date().toISOString().slice(0, 10),
  scheme: "equirectangular",
  origin: ORIGIN,
  metersPerUnit: METERS_PER_UNIT,
  riverHalfWidth: round(RIVER_HALF_WIDTH_M / METERS_PER_UNIT),
  window,
  windowTouchMargin: WINDOW_TOUCH_MARGIN,
  fullExtent,
  rivers: selected,
  bridges: inWindow
};

const banner = `/**
 * 自动生成，请勿手工编辑——改数据请改 tools/build-geo.mjs 后重跑：
 *
 *   node tools/build-geo.mjs --preview
 *
 * 数据来源：${payload.source}，许可 ${payload.license}。
 * 投影：等距圆柱，原点 ${ORIGIN.lat}, ${ORIGIN.lon}；1 世界单位 = ${METERS_PER_UNIT} 米。
 * 生成日期：${payload.generatedAt}
 */

export const GEO = `;

fs.writeFileSync(OUT_FILE, banner + JSON.stringify(payload, null, 2) + ";\n\nexport default GEO;\n", "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_FILE)}`);
