/**
 * 统计 Overpass CSV（第一列 ::id，第二列 building，第三列 height，第四列 building:levels，第五列 name）。
 */
import fs from "node:fs";

const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const lines = text.trim().split(/\r?\n/);
const rows = lines.filter((l) => l.trim() !== "");
const kindCounts = {};
let withHeight = 0;
let withLevels = 0;
let withEither = 0;
let named = 0;
const heights = [];

for (const row of rows) {
  const cols = row.split("\t");
  const id = cols[0];
  const building = cols[1] || "";
  const height = cols[2] || "";
  const levels = cols[3] || "";
  const name = cols[4] || "";
  if (!/^\d+$/.test(id)) continue; // skip header line if any
  kindCounts[building || "(none)"] = (kindCounts[building || "(none)"] || 0) + 1;
  const h = height.trim() !== "";
  const lv = levels.trim() !== "";
  if (h) {
    withHeight += 1;
    const v = parseFloat(height);
    if (Number.isFinite(v)) heights.push(v);
  }
  if (lv) withLevels += 1;
  if (h || lv) withEither += 1;
  if (name.trim() !== "") named += 1;
}

const total = Object.values(kindCounts).reduce((a, b) => a + b, 0);
const pct = (n) => (total ? ((n / total) * 100).toFixed(1) + "%" : "0%");
console.log(`total=${total}`);
console.log(`with_height=${withHeight} (${pct(withHeight)})`);
console.log(`with_levels=${withLevels} (${pct(withLevels)})`);
console.log(`with_either=${withEither} (${pct(withEither)})`);
console.log(`named=${named} (${pct(named)})`);
if (heights.length) {
  heights.sort((a, b) => a - b);
  const pick = (q) => heights[Math.min(heights.length - 1, Math.floor(q * heights.length))];
  console.log(
    `height meters: min=${heights[0]} p50=${pick(0.5)} p90=${pick(0.9)} p99=${pick(0.99)} max=${heights[heights.length - 1]}`
  );
}
const topKinds = Object.entries(kindCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);
console.log("top building kinds:", topKinds.map(([k, n]) => `${k}=${n}`).join(" "));
