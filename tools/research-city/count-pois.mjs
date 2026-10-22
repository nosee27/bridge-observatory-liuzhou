/**
 * 统计 liuzhou-pois.json：amenity/tourism/historic 各自数量与 top 类型。
 * 另挑出名字含地标关键词的 POI（山/公园/庙/塔/城楼/码头/古镇等）。
 */
import fs from "node:fs";

const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const counts = { amenity: 0, tourism: 0, historic: 0 };
const byKind = { amenity: {}, tourism: {}, historic: {} };
const named = [];

for (const el of data.elements) {
  const t = el.tags || {};
  const lat = el.lat ?? (el.center && el.center.lat);
  const lon = el.lon ?? (el.center && el.center.lon);
  for (const k of ["amenity", "tourism", "historic"]) {
    if (t[k]) {
      counts[k] += 1;
      byKind[k][t[k]] = (byKind[k][t[k]] || 0) + 1;
    }
  }
  if (t.name && (t.tourism || t.historic)) {
    named.push({ name: t.name, tourism: t.tourism, historic: t.historic, lat, lon });
  }
}

console.log("counts:", JSON.stringify(counts));
for (const k of Object.keys(byKind)) {
  const top = Object.entries(byKind[k]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`${k}:`, top.map(([x, n]) => `${x}=${n}`).join(" "));
}
console.log("--- named tourism/historic POIs ---");
for (const p of named) {
  console.log(`${p.name}\t${p.tourism || p.historic}\t${p.lat ? p.lat.toFixed(5) + "," + p.lon.toFixed(5) : "?"}`);
}
