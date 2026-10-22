/**
 * 地标经纬度 → 项目世界坐标（照抄 tools/build-geo.mjs 的 project()）。
 * 并反算取景窗口的经纬度范围做口径对照。
 */
const R = 6378137;
const ORIGIN = { lat: 24.342, lon: 109.42 };
const METERS_PER_UNIT = 100;

function project(lat, lon) {
  const x = (((lon - ORIGIN.lon) * Math.PI) / 180) * R * Math.cos((ORIGIN.lat * Math.PI) / 180);
  const y = (((lat - ORIGIN.lat) * Math.PI) / 180) * R;
  return { x: x / METERS_PER_UNIT, z: -y / METERS_PER_UNIT };
}

function unproject(x, z) {
  const y = -z * METERS_PER_UNIT;
  const lat = ORIGIN.lat + (y / R) * (180 / Math.PI);
  const lon = ORIGIN.lon + ((x * METERS_PER_UNIT) / (R * Math.cos((ORIGIN.lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat, lon };
}

// 取景窗口四角 → 经纬度（说明宽 bbox 与窗口的关系）
const win = { minX: -34, maxX: 20, minZ: -52, maxZ: 44 };
for (const [label, x, z] of [
  ["window SW(minX,minZ)", win.minX, win.minZ],
  ["window NE(maxX,maxZ)", win.maxX, win.maxZ]
]) {
  const g = unproject(x, z);
  console.log(`${label}: x=${x} z=${z} -> lat ${g.lat.toFixed(5)}, lon ${g.lon.toFixed(5)}`);
}

const landmarks = [
  ["地王国际财富中心", 24.3233175, 109.4070602, "311m/73F, OSM building height=311"],
  ["柳州保利中心", 24.338519, 109.4106052, "254m/53F"],
  ["A栋(地王公馆?)", 24.3243797, 109.4049863, "228m/62F"],
  ["三胞广场", 24.3235129, 109.4278451, "215.4m/38F"],
  ["乐和大厦", 24.3267557, 109.4343926, "211m/42F"],
  ["柳州华润大厦", 24.3252443, 109.4472002, "210m/47F"],
  ["马鞍山(山体way中心)", 24.30547, 109.41116, "270m peak"],
  ["马鞍山公园", 24.30336, 109.40946, "park"],
  ["立鱼峰(鱼峰山)", 24.30507, 109.406, "154m"],
  ["窑埠古镇(way center)", 24.32213, 109.42329, "古镇街区"],
  ["窑埠古镇(沿江段)", 24.31883, 109.42356, "古镇街区"],
  ["窑埠码头(ferry_terminal)", 24.318, 109.42075, "码头"],
  ["柳州饭店(hotel)", 24.32526, 109.41359, "五星"],
  ["东门城楼", 24.31417, 109.41234, "明代城楼"],
  ["蟠龙塔", 24.3157, 109.42055, "26.28m"],
  ["文光塔", 24.31476, 109.42185, "20.13m"],
  ["蟠龙山(peak)", 24.31495, 109.42194, "197m"],
  ["柳侯祠", 24.3188, 109.41076, "ruins"],
  ["柳侯公园", 24.32029, 109.4109, "park"],
  ["鹅山(peak)", 24.31577, 109.38026, "peak"],
  ["马鹿山(peak)", 24.34674, 109.43761, "peak"],
  ["雀儿山(peak)", 24.37492, 109.3981, "peak（窗口北界外 1.4km）"],
  ["箭盘山(peak)", 24.30688, 109.42846, "peak"],
  ["柳州之门(白沙大桥塔)", 24.35071, 109.41693, "attraction"],
  ["柳州博物馆", 24.32171, 109.40793, "museum"],
  ["柳州工业博物馆", 24.32268, 109.42476, "museum/park"],
  ["江滨公园(artwork)", 24.30841, 109.40788, "artwork"],
  ["柳宗元雕像", 24.31777, 109.41134, "artwork"]
];

const round = (v) => Math.round(v * 100) / 100;
console.log("--- landmark -> project coords ---");
for (const [name, lat, lon, note] of landmarks) {
  const p = project(lat, lon);
  const inWin = p.x >= win.minX && p.x <= win.maxX && p.z >= win.minZ && p.z <= win.maxZ;
  console.log(
    `${name}\tx=${round(p.x)}\tz=${round(p.z)}\t${inWin ? "窗口内" : "窗口外"}\t${note}`
  );
}
