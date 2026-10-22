/**
 * 统计 liuzhou-buildings.csv（Overpass [out:csv] 产物，@路径由 argv 传入）。
 * 用途：报告 03-城市与建筑.md 的 OSM 覆盖度实测。
 */
import fs from "node:fs";

const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const lines = text.trim().split(/\r?\n/);
const header = lines[0].split("\t");
console.log("header:", JSON.stringify(header));

const rows = lines.slice(1).filter((l) => l.trim() !== "");
const kindCounts = {};
let withHeight = 0;
let withLevels = 0;
let withEither = 0;
let named = 0;
const heights = [];

for (const row of rows) {
  const [building, height, levels, name] = row.split("\t");
  kindCounts[building] = (kindCounts[building] || 0) + 1;
  const h = (height || "").trim() !== "";
  const lv = (levels || "").trim() !== "";
  if (h) {
    withHeight += 1;
    const v = parseFloat(height);
    if (Number.isFinite(v)) heights.push(v);
  }
  if (lv) withLevels += 1;
  if (h || lv) withEither += 1;
  if ((name || "").trim() !== "") named += 1;
}

const total = rows.length;
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
  .slice(0, 8);
console.log("top building kinds:", topKinds.map(([k, n]) => `${k}=${n}`).join(" "));
