/**
 * OSM 城市数据覆盖度实测（一次性调研脚本，产物写 stderr + JSON 文件）。
 * 服务器顺序沿用 tools/build-geo.mjs；结果缓存到本目录。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = "bridge-observatory-liuzhou/1.0 (educational static site)";
const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

async function overpass(query, label) {
  for (const server of SERVERS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const t0 = Date.now();
        const response = await fetch(server, {
          method: "POST",
          headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(240000)
        });
        const text = await response.text();
        const ms = Date.now() - t0;
        if (response.ok && text.includes('"elements"')) {
          console.error(`[${label}] ${server.split("/")[2]} ok ${text.length}B ${ms}ms`);
          return JSON.parse(text);
        }
        console.error(`[${label}] ${server.split("/")[2]} status=${response.status} len=${text.length} retry`);
      } catch (error) {
        console.error(`[${label}] ${server.split("/")[2]} ${error.message}`);
      }
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
  throw new Error(`[${label}] all servers failed`);
}

const BBOX = "24.30,109.36,24.38,109.50";

/* ---------- 1. buildings: 用 CSV 输出直接拿标签，一个请求全拿到 ---------- */
const buildingQuery = `[out:csv(name, "building", height, "building:levels", lat, lon; false)][timeout:180];
(
  way["building"](${BBOX});
  relation["building"](${BBOX});
);
out tags center;`;

const buildings = await overpass(buildingQuery, "buildings");
fs.writeFileSync(path.join(HERE, ".cache-buildings.csv"), buildings, "utf8");

const lines = buildings.trim().split(/\r?\n/).slice(1).filter(Boolean);
const withHeight = lines.filter((l) => {
  const cols = l.split(",");
  return cols[2] !== "" && cols[2] !== undefined;
});
const withLevels = lines.filter((l) => {
  const cols = l.split(",");
  return cols[3] !== "" && cols[3] !== undefined;
});
const withEither = lines.filter((l) => {
  const cols = l.split(",");
  return (cols[2] !== "" && cols[2] !== undefined) || (cols[3] !== "" && cols[3] !== undefined);
});
console.error(`[buildings] total=${lines.length} height=${withHeight.length} levels=${withLevels.length} either=${withEither.length}`);

/* ---------- 2. highway 里程/数量: 用 out geometry 逐 way 算长 ---------- */
const highwayQuery = `[out:json][timeout:180];
way["highway"](${BBOX});
out tags geom;`;

const hw = await overpass(highwayQuery, "highways");
fs.writeFileSync(path.join(HERE, ".cache-highways.json"), JSON.stringify(hw), "utf8");

const R = 6378137;
const ORIGIN_LAT = 24.342;
const meterPerDegLat = (Math.PI / 180) * R;
const meterPerDegLon = meterPerDegLat * Math.cos((ORIGIN_LAT * Math.PI) / 180);
const wayKinds = { motorway: 0, trunk: 0, primary: 0, secondary: 0, tertiary: 0, residential: 0, unclassified: 0, service: 0, living_street: 0, footway: 0, cycleway: 0, path: 0, steps: 0, pedestrian: 0, track: 0, other: 0 };
const kindWayCount = { ...wayKinds };
const kindMeters = Object.fromEntries(Object.keys(wayKinds).map((k) => [k, 0]));
let waysTotal = 0;
for (const el of hw.elements) {
  if (!el.geometry || el.geometry.length < 2) continue;
  const tag = el.tags ? el.tags.highway : undefined;
  if (!tag) continue;
  waysTotal += 1;
  const kind = wayKinds[tag] !== undefined ? tag : "other";
  kindWayCount[kind] += 1;
  let len = 0;
  for (let i = 1; i < el.geometry.length; i += 1) {
    const a = el.geometry[i - 1], b = el.geometry[i];
    if (!a || !b) continue;
    const dx = (b.lon - a.lon) * meterPerDegLon;
    const dy = (b.lat - a.lat) * meterPerDegLat;
    len += Math.hypot(dx, dy);
  }
  kindMeters[kind] += len;
}
console.error(`[highways] ways=${waysTotal}`);
for (const k of Object.keys(wayKinds)) {
  if (kindWayCount[k] || kindMeters[k]) {
    console.error(`  ${k}: ways=${kindWayCount[k]} km=${(kindMeters[k] / 1000).toFixed(1)}`);
  }
}

/* ---------- 3. landuse / POI: 用 csv 一次拿 ---------- */
const poiQuery = `[out:csv(name, amenity, tourism, historic, leisure, lat, lon; false)][timeout:120];
(
  node["amenity"](${BBOX});
  node["tourism"](${BBOX});
  node["historic"](${BBOX});
);
out tags;`;
const pois = await overpass(poiQuery, "pois");
fs.writeFileSync(path.join(HERE, ".cache-pois.csv"), pois, "utf8");
const poiLines = pois.trim().split(/\r?\n/).slice(1).filter(Boolean);
const counts = { amenity: 0, tourism: 0, historic: 0 };
for (const l of poiLines) {
  const c = l.split(",");
  if (c[1]) counts.amenity += 1;
  if (c[2]) counts.tourism += 1;
  if (c[3]) counts.historic += 1;
}
console.error(`[pois] nodes=${poiLines.length} ${JSON.stringify(counts)}`);

const landuseQuery = `[out:csv(name, landuse, leisure, natural, way_area; false)][timeout:120];
(
  way["landuse"](${BBOX});
  relation["landuse"](${BBOX});
  way["leisure"="park"](${BBOX});
  way["natural"="water"](${BBOX});
);
out tags;`;
const landuseRaw = await overpass(landuseQuery, "landuse");
fs.writeFileSync(path.join(HERE, ".cache-landuse.csv"), landuseRaw, "utf8");
const luLines = landuseRaw.trim().split(/\r?\n/).slice(1).filter(Boolean);
const luCounts = {};
for (const l of luLines) {
  const c = l.split(",");
  const key = c[1] || (c[2] ? "leisure:" + c[2] : c[3] ? "natural:" + c[3] : "?");
  luCounts[key] = (luCounts[key] || 0) + 1;
}
console.error(`[landuse] polys=${luLines.length} ${JSON.stringify(luCounts)}`);

console.error("ALL DONE");
