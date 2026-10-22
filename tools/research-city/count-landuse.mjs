/**
 * 统计 liuzhou-landuse.json + liuzhou-landmarks.json（调研临时脚本）。
 */
import fs from "node:fs";

/* landuse: way+relation, out tags bb → 每个 element 有 bounds */
const lu = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const R = 6378137;
const M_PER_DEG_LAT = (Math.PI / 180) * R;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((24.342 * Math.PI) / 180);

const buckets = {};
let areaSum = {};
for (const el of lu.elements) {
  const t = el.tags || {};
  const kind = t.landuse || (t.leisure ? "leisure:" + t.leisure : "?");
  const b = el.bounds;
  if (!b) continue;
  const wKm = ((b.maxlon - b.minlon) * M_PER_DEG_LON) / 1000;
  const hKm = ((b.maxlat - b.minlat) * M_PER_DEG_LAT) / 1000;
  const area = wKm * hKm; // 包围盒近似
  buckets[kind] = (buckets[kind] || 0) + 1;
  areaSum[kind] = (areaSum[kind] || 0) + area;
}
console.log("--- landuse / park (bbox approx km2) ---");
const rows = Object.keys(buckets).sort((a, b) => areaSum[b] - areaSum[a]);
for (const k of rows) {
  console.log(`${k}\tpolys=${buckets[k]}\tarea≈${areaSum[k].toFixed(2)}km2`);
}

/* landmarks: 原样打印（数量少） */
const lm = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
console.log("--- landmarks raw ---");
for (const el of lm.elements) {
  const t = el.tags || {};
  const lat = el.lat ?? (el.center && el.center.lat);
  const lon = el.lon ?? (el.center && el.center.lon);
  const bbox = el.bounds ? `${el.bounds.minlat},${el.bounds.minlon},${el.bounds.maxlat},${el.bounds.maxlon}` : "";
  console.log(
    `${t.name || "(unnamed)"}\t${t.historic || t.tourism || t.natural || t.waterway || t.man_made}\t${lat ? lat.toFixed(5) + "," + lon.toFixed(5) : bbox}`
  );
}
