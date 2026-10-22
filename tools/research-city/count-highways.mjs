/**
 * 统计 liuzhou-highways.json（Overpass out tags geom 产物）。
 * 按等级输出 way 数与近似里程（等距圆柱近似，原点纬度 24.342）。
 */
import fs from "node:fs";

const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, "utf8"));

const R = 6378137;
const ORIGIN_LAT = 24.342;
const M_PER_DEG_LAT = (Math.PI / 180) * R;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN_LAT * Math.PI) / 180);

const DRIVE = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);
const stats = {};
let noTag = 0;

for (const el of data.elements) {
  const tag = el.tags && el.tags.highway;
  if (!tag) {
    noTag += 1;
    continue;
  }
  if (!stats[tag]) stats[tag] = { ways: 0, meters: 0 };
  stats[tag].ways += 1;
  const g = el.geometry || [];
  let len = 0;
  for (let i = 1; i < g.length; i += 1) {
    const a = g[i - 1];
    const b = g[i];
    if (!a || !b) continue;
    const dx = (b.lon - a.lon) * M_PER_DEG_LON;
    const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
    len += Math.hypot(dx, dy);
  }
  stats[tag].meters += len;
}

const rows = Object.entries(stats).sort((a, b) => b[1].meters - a[1].meters);
let totalWays = 0;
let totalKm = 0;
let driveKm = 0;
console.log("kind\tways\tkm");
for (const [kind, s] of rows) {
  totalWays += s.ways;
  totalKm += s.meters / 1000;
  if (DRIVE.has(kind)) driveKm += s.meters / 1000;
  console.log(`${kind}\t${s.ways}\t${(s.meters / 1000).toFixed(1)}`);
}
console.log(`TOTAL\t${totalWays}\t${totalKm.toFixed(1)}`);
console.log(`drivable_total_km=${driveKm.toFixed(1)}`);
console.log(`elements=${data.elements.length} notag_ways=${noTag}`);
