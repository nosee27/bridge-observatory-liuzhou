import fs from "node:fs";
const d = JSON.parse(fs.readFileSync(process.env.LOCALAPPDATA + "/Temp/landmarks.json", "utf8"));
for (const el of d.elements) {
  const t = el.tags || {};
  const hits = ["东门", "龙城阁", "文惠", "城楼", "东楼"].some((s) => (t.name || "").includes(s));
  if (hits) {
    const c = el.center || {};
    console.log(el.type + "/" + el.id, JSON.stringify(t.name), c.lat, c.lon, JSON.stringify(t).slice(0, 220));
  }
}
console.log("--- total elements:", d.elements.length);
