import fs from "node:fs";
const d = JSON.parse(fs.readFileSync(process.env.LOCALAPPDATA + "/Temp/dongmen.json", "utf8"));
for (const el of d.elements) {
  const t = el.tags || {};
  const c = el.center || {};
  console.log(
    el.type + "/" + el.id,
    JSON.stringify(t.name || ""),
    c.lat, c.lon,
    Object.entries(t)
      .filter(([k]) => !["name", "name:en", "name:zh"].includes(k))
      .map(([k, v]) => k + "=" + v)
      .join(",")
      .slice(0, 140)
  );
}
