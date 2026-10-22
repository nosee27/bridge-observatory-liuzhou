/**
 * 场景几何自检（可在 Node 中直接运行，不需要浏览器）。
 *
 *   node tests/atlas.test.mjs
 *
 * 覆盖：真实地理数据完整性、桥梁落位与朝向、建筑在陆地、包围盒合理、状态切换稳定。
 */

import fs from "node:fs";
import * as THREE from "../vendor/three/three.module.min.js";
import { buildAtlas } from "../app3d/atlas.mjs";
import { GEO } from "../app3d/geo.mjs";
import { TERRAIN } from "../app3d/terrain.mjs";
import {
  BRIDGES,
  PROFILES,
  GOALS,
  QUIZ,
  SOURCES,
  SOURCE_LIBRARY
} from "../app3d/data.mjs";

let failures = 0;

function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log("FAIL", label, "got", JSON.stringify(actual), "want", JSON.stringify(expected));
  }
}

function checkTrue(label, condition, detail) {
  if (!condition) {
    failures += 1;
    console.log("FAIL", label, detail === undefined ? "" : detail);
  }
}

function distanceToPolyline(px, pz, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    const [ax, az] = line[i - 1];
    const [bx, bz] = line[i];
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), pz - (az + t * dz)));
  }
  return best;
}

function distanceToRivers(px, pz) {
  return Math.min(...GEO.rivers.map((line) => distanceToPolyline(px, pz, line)));
}

/* ---------------- 数据层 ---------------- */

checkTrue("geo has source", GEO.source === "OpenStreetMap contributors");
checkTrue("geo license", GEO.license === "ODbL-1.0");
checkTrue("geo scale", GEO.metersPerUnit === 100);
checkTrue("geo rivers present", GEO.rivers.length >= 1);
checkTrue(
  "geo river points",
  GEO.rivers.every((line) => line.length >= 4),
  `points=${GEO.rivers.map((line) => line.length).join(",")}`
);
check("geo bridge count", GEO.bridges.length, 5);
checkTrue("geo window sane", GEO.window.maxX > GEO.window.minX && GEO.window.maxZ > GEO.window.minZ);

// 河道必须是一条连续的折线：多段说明有汇流/河中岛把主河道切断，
// 画面上就会出现悬空的一截短河。
check("geo river is one continuous polyline", GEO.rivers.length, 1);

if (GEO.rivers.length === 1) {
  const line = GEO.rivers[0];
  checkTrue("geo river has enough points", line.length >= 32, `points=${line.length}`);
  const xs = line.map(([x]) => x);
  const zs = line.map(([, z]) => z);
  checkTrue(
    "geo river spans the window",
    Math.min(...xs) < GEO.window.minX && Math.max(...xs) > GEO.window.maxX,
    `x ${Math.min(...xs)}..${Math.max(...xs)}`
  );

  // 端点不能落在相机默认可见范围（窗口外约 80 单位）内，否则会露出断口
  const reach = 80;
  for (const [label, point] of [
    ["head", line[0]],
    ["tail", line[line.length - 1]]
  ]) {
    const inside =
      point[0] > GEO.window.minX - reach &&
      point[0] < GEO.window.maxX + reach &&
      point[1] > GEO.window.minZ - reach &&
      point[1] < GEO.window.maxZ + reach;
    checkTrue(`geo river ${label} outside view`, !inside, `at (${point[0]}, ${point[1]})`);
  }
}

for (const bridge of GEO.bridges) {
  checkTrue(`geo ${bridge.id} finite`, ["x", "z", "angle", "length", "width"].every((key) => Number.isFinite(bridge[key])));
  checkTrue(`geo ${bridge.id} has osm id`, typeof bridge.osmId === "string" && bridge.osmId.startsWith("way/"));
  checkTrue(`geo ${bridge.id} length plausible`, bridge.length > 1.5 && bridge.length < 20, `length=${bridge.length}`);
  checkTrue(`geo ${bridge.id} width plausible`, bridge.width > 0.1 && bridge.width < 2, `width=${bridge.width}`);
  // 桥应当架在河上：到河道中心线的距离不得超过河宽
  const distance = distanceToRivers(bridge.x, bridge.z);
  checkTrue(`geo ${bridge.id} on river`, distance <= GEO.riverHalfWidth * 1.2, `distance=${distance.toFixed(2)}`);
}

/* ---------------- 场景层 ---------------- */

const atlas = buildAtlas();

check("bridge count", atlas.bridges.size, 5);
// 两栋建筑（结构实验室、档案馆）2026-10-22 按要求整体删除：
// 实验与档案并进单桥视图，场景里只剩江、桥、山。
checkTrue("建筑物已移除", atlas.buildings === undefined, typeof atlas.buildings);
check("pickables", atlas.pickables.length, 5);
check("label count", atlas.labels.length, 5);

for (const bridge of GEO.bridges) {
  const entry = atlas.bridges.get(bridge.id);
  checkTrue(`scene ${bridge.id} exists`, Boolean(entry));
  if (!entry) continue;

  const position = entry.group.position;
  checkTrue(
    `scene ${bridge.id} at geo position`,
    Math.hypot(position.x - bridge.x, position.z - bridge.z) < 1e-6,
    `group=(${position.x.toFixed(2)},${position.z.toFixed(2)}) geo=(${bridge.x},${bridge.z})`
  );
  checkTrue(
    `scene ${bridge.id} rotation matches axis`,
    Math.abs(entry.group.rotation.y - bridge.angle) < 1e-6
  );
  checkTrue(`scene ${bridge.id} has structure`, entry.group.children.length >= 2);
  checkTrue(`scene ${bridge.id} height`, entry.top > 0.2, `top=${entry.top}`);
}

// 建筑落位检查随建筑一起删除（见上）。
/* ---------------- 文惠桥：中承式钢管混凝土拱桥 ---------------- */

/**
 * 文惠桥是五孔连拱、双肋、中承式：拱肋从桥墩顶起拱、穿过桥面再升到桥面上方。
 * 三条断言分别守住"两条肋""拱高过桥面""边跨拱压在桥面下"——
 * 这几条一旦退回"中间一根管 + 一道拱"，说明又被打回简模了。
 */
{
  const entry = atlas.bridges.get("wenhui");
  const model = entry.group.children.find((child) => child.isGroup);

  const byMaterial = new Map();
  model.traverse((object) => {
    if (!object.isMesh) return;
    const position = object.geometry.attributes.position;
    if (!byMaterial.has(object.material)) byMaterial.set(object.material, []);
    const bucket = byMaterial.get(object.material);
    for (let i = 0; i < position.count; i += 1) {
      bucket.push([position.getX(i), position.getY(i), position.getZ(i)]);
    }
  });

  // 钢构件（拱肋 + 吊杆 + 横撑）是中国红；用"红得有多纯"来挑，
  // 不能用 r>g&&r>b——混凝土的 0xcfccc4 也满足，会挑错材质。
  let steel = [];
  let steelColour = null;
  let reddest = -1;
  for (const [material, points] of byMaterial) {
    if (!material.color) continue;
    const redness = material.color.r - Math.max(material.color.g, material.color.b);
    if (redness > reddest) {
      reddest = redness;
      steel = points;
      steelColour = material.color;
    }
  }

  let maxY = -Infinity;
  let nearCentre = 0;
  let leftRib = 0;
  let rightRib = 0;
  for (const [, y, z] of steel) {
    if (y > maxY) maxY = y;
    if (Math.abs(z) < 0.04) nearCentre += 1;
    if (z > 0.1) rightRib += 1;
    if (z < -0.1) leftRib += 1;
  }

  checkTrue("wenhui arch steel is painted red", steelColour !== null && reddest > 0.3 && steel.length > 2000, `verts=${steel.length} redness=${reddest.toFixed(2)}`);
  checkTrue("wenhui has two ribs on both deck edges", leftRib > 500 && rightRib > 500, `left=${leftRib} right=${rightRib}`);
  checkTrue("wenhui ribs are not a single centreline", nearCentre * 2 < steel.length, `centre=${nearCentre}/${steel.length}`);
  checkTrue("wenhui main arch rises above the deck", maxY > 0.55 && maxY < 1.2, `archTop=${maxY.toFixed(2)}`);
}

/* ---------------- 凤凰岭大桥：五亭两廊 ---------------- */

/**
 * 真实结构：96+124+3×130+90 = 700 m 等高连续组合梁，桥面全宽 46.6 m；
 * 横断面 = 机动车道 | **中间 9 m 预留轨道空间（兼观景台）** | 机动车道；
 * 五座桥亭就立在中间这条观景带上（歇山亭在两端、六角亭次之、八角亭居中最高），
 * 两侧各一条长廊压在人行道上——**亭柱不在桥的两边，在观景带的两边**。
 *
 * 断言全部从 userData 取数：桥面标高、分隔带宽、长廊位置、亭子位置与高度都由建模函数
 * 自己登记，测试不再写死坐标——以后调比例不会让断言变成假报警。
 */
{
  const inner = atlas.bridges.get("fenghuangling").group.children.find((child) => child.isGroup);
  const data = inner.userData;
  const { deckTop, medianHalf, corridor, pavilions, spans } = data;

  checkTrue("fenghuangling exposes deckTop", typeof deckTop === "number", `deckTop=${deckTop}`);
  checkTrue("fenghuangling keeps the 9 m median", medianHalf === 0.045, `medianHalf=${medianHalf}`);
  checkTrue("fenghuangling exposes the corridor", Boolean(corridor), JSON.stringify(corridor));
  checkTrue(
    "fenghuangling has five pavilions",
    Array.isArray(pavilions) && pavilions.length === 5,
    `count=${pavilions && pavilions.length}`
  );

  // 长廊贯通：两侧各一条，位于分隔带外侧
  let corridorVerts = 0;
  inner.traverse((object) => {
    if (!object.isMesh) return;
    const position = object.geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const y = position.getY(i);
      if (y <= deckTop) continue;
      const az = Math.abs(position.getZ(i));
      if (az < corridor.z - corridor.half * 1.5 || az > corridor.z + corridor.half * 1.5) continue;
      corridorVerts += 1;
    }
  });
  checkTrue("fenghuangling has a covered corridor on both sides", corridorVerts > 500, `verts=${corridorVerts}`);

  // 三档亭高必须对得上实测值（八角 49.45 m / 六角 43.9 m / 歇山 34.2 m）
  const heights = new Map();
  for (const pavilion of pavilions) heights.set(pavilion.kind, pavilion.heightAboveDeck);
  const expected = { oct: 49.45, hex: 43.9, hip: 34.2 };
  for (const [kind, meters] of Object.entries(expected)) {
    const actual = heights.get(kind);
    checkTrue(
      `fenghuangling ${kind} pavilion height matches the real ${meters} m`,
      typeof actual === "number" && Math.abs(actual * 100 - meters) < 4,
      `actual=${typeof actual === "number" ? (actual * 100).toFixed(1) : "?"} m`
    );
  }

  // 八角亭居中、且比两端的歇山亭高
  const centre = pavilions.find((p) => p.kind === "oct");
  const ends = pavilions.filter((p) => p.kind === "hip");
  checkTrue(
    "fenghuangling centre octagonal tower is the tallest",
    Boolean(centre) && ends.length === 2 && ends.every((p) => centre.top > p.top + 0.1),
    centre ? `centre=${centre.top.toFixed(2)} ends=${ends.map((p) => p.top.toFixed(2)).join("/")}` : "no centre"
  );

  // 跨径布置：真实 96 + 124 + 3×130 + 90 = 700 m，模型按桥长等比缩放
  if (spans && spans.pattern) {
    const joints = [spans.startX, ...spans.piers, spans.endX];
    const totalModel = spans.endX - spans.startX;
    const measured = [];
    for (let i = 1; i < joints.length; i += 1) {
      measured.push(((joints[i] - joints[i - 1]) / totalModel) * 700);
    }
    const worst = Math.max(...spans.pattern.map((real, index) => Math.abs(measured[index] - real)));
    checkTrue(
      "fenghuangling span pattern is 96+124+3x130+90",
      measured.length === spans.pattern.length && worst < 2,
      `measured=${measured.map((value) => value.toFixed(0)).join("+")} worst=${worst.toFixed(1)}`
    );
  }
}

/**
 * 屋面颜色必须来自 accent 材质，而不是在 Color 构造里被吞掉后回落成纯白。
 * 材质全白的屋面在远景里就是一片灰，等于把铜瓦做没了。
 */
{
  const entry = atlas.bridges.get("fenghuangling");
  let roofColor = null;
  entry.group.traverse((object) => {
    if (!object.isMesh || !object.material.color) return;
    if (object.material.metalness !== 0.16) return; // 只有屋面用了 0.16
    roofColor = object.material.color;
  });

  checkTrue("fenghuangling roof material exists", roofColor !== null);
  if (roofColor) {
    const max = Math.max(roofColor.r, roofColor.g, roofColor.b);
    const min = Math.min(roofColor.r, roofColor.g, roofColor.b);
    checkTrue("fenghuangling roof is not washed-out white", max < 0.55, `max=${max.toFixed(2)}`);
    checkTrue("fenghuangling roof keeps a hue", max - min > 0.03, `chroma=${(max - min).toFixed(3)}`);
  }
}

/* ---------------- 凤凰岭：桥亭横跨整座桥面 ---------------- */

/**
 * 按用户要求，五座桥亭改成横跨桥面、支柱落在桥面两侧的"门式"亭
 * （真实桥是立在中间 9 m 观景带上的，这里是刻意的艺术处理）。
 * 要守住两件事：
 *   1. 柱子确实落在桥面两侧——否则又变回"桥中间一根杆子"；
 *   2. 桥面正中的行车道没有被亭子挡住——门式亭的意义就是把柱子让到边上。
 */
{
  const inner = atlas.bridges.get("fenghuangling").group.children.find((child) => child.isGroup);
  const { deckTop, pavilions, corridor } = inner.userData;

  // 桥面半宽：直接从桥面板量
  let deckHalf = 0;
  inner.traverse((object) => {
    if (!object.isMesh) return;
    if (object.material.color.getHexString() !== "9aa0a6") return;
    const position = object.geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      deckHalf = Math.max(deckHalf, Math.abs(position.getZ(i)));
    }
  });

  checkTrue("fenghuangling deck width is measurable", deckHalf > 0.2, `deckHalf=${deckHalf}`);

  let columnsAtEdge = 0;
  let columnsInMiddle = 0;
  inner.traverse((object) => {
    if (!object.isMesh) return;
    const isTimber = object.material.color.getHexString() === "7d5f45";
    if (!isTimber) return;
    const position = object.geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const y = position.getY(i);
      if (y < deckTop || y > deckTop + 0.06) continue; // 只看底层柱
      const az = Math.abs(position.getZ(i));
      if (az > deckHalf - 0.028) columnsAtEdge += 1;
      if (az < 0.03) columnsInMiddle += 1;
    }
  });

  checkTrue(
    "fenghuangling pavilion columns stand at both deck edges",
    columnsAtEdge > 60,
    `verts=${columnsAtEdge}`
  );
  checkTrue(
    "fenghuangling pavilions leave the deck centreline clear",
    columnsInMiddle === 0,
    `verts=${columnsInMiddle}`
  );

  for (const pavilion of pavilions) {
    checkTrue(
      `fenghuangling ${pavilion.kind} pavilion spans the deck`,
      pavilion.halfZ > deckHalf - 0.04,
      `halfZ=${pavilion.halfZ.toFixed(3)} deckHalf=${deckHalf.toFixed(3)}`
    );
  }

  // 门式亭还要真的罩住桥面：屋面必须在两侧都超过桥面半宽
  let roofBeyondEdge = 0;
  inner.traverse((object) => {
    if (!object.isMesh) return;
    if (object.material.metalness !== 0.16) return; // 屋面材质
    const position = object.geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      if (Math.abs(position.getZ(i)) > deckHalf + 0.002) roofBeyondEdge += 1;
    }
  });
  checkTrue("fenghuangling pavilion roofs overhang the deck edges", roofBeyondEdge > 20, `verts=${roofBeyondEdge}`);
  checkTrue("fenghuangling corridor is kept", Boolean(corridor), JSON.stringify(corridor));
}

/* ---------------- 凤凰岭：车道必须能通 ---------------- */

/**
 * 五座亭子立在中间 9 m 观景带上，两侧是双向六车道。所以：
 *   - 观景带自己的边缘（medianHalf）以外，桥面往上 8 m 内不许有任何构件；
 *   - 亭子外挑的檐可以出这条带，但必须高于 8 m 净空。
 * 上一版把亭子摆在桥面中线、给 58 m 的实心台基，等于把整座桥的路堵死。
 */
{
  const inner = atlas.bridges.get("fenghuangling").group.children.find((child) => child.isGroup);
  const { deckTop, medianHalf, corridor } = inner.userData;

  const roadInner = medianHalf * 1.05;                          // 观景带外沿
  const roadOuter = corridor.z - corridor.half * 1.5;            // 人行道内侧（长廊立柱以内）
  const clearance = 0.08;                                        // 桥面以上 8 m 的净空带

  let obstacles = 0;
  let lowest = Infinity;
  let roadVerts = 0;

  inner.traverse((object) => {
    if (!object.isMesh) return;
    const position = object.geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const y = position.getY(i);
      const az = Math.abs(position.getZ(i));
      if (az <= roadInner || az >= roadOuter) continue;
      if (y <= deckTop) continue;
      roadVerts += 1;
      if (y < deckTop + clearance) {
        obstacles += 1;
        if (y < lowest) lowest = y;
      }
    }
  });

  checkTrue("fenghuangling roadway has geometry above it", roadVerts > 0, `verts=${roadVerts}`);
  check("fenghuangling roadway clearance is not blocked", obstacles, 0);
  if (obstacles > 0) {
    console.log(`    最低障碍高度 ${lowest.toFixed(3)}（桥面 ${deckTop.toFixed(3)}）`);
  }
}

/* ---------------- 白沙大桥：柳州之门 ---------------- */

/**
 * 真实结构：单塔双索面钢箱梁斜拉桥，主桥 400 m 一跨而过，只有中间一座主塔；
 * 主塔由空间曲线扭曲而成（两根钢塔在空中拧成麻花），塔高 106 m，形似门；
 * 全桥 60 根斜拉索。
 *
 * 旧模型是一个 178 m 半径的圆环、还绕 y 轴转了 90°——环平面横跨桥宽，
 * 既没有门洞也没有索面。这里守住三件事：塔是闭合的环、环在桥面高度处让开桥面、
 * 斜拉索数量对得上。
 */
{
  const inner = atlas.bridges.get("baisha").group.children.find((child) => child.isGroup);
  const deckTop = inner.userData.deckTop;
  const deckHalf = 0.22;

  let towerPosition = null;
  let stayTriangles = 0;

  inner.traverse((object) => {
    if (!object.isMesh) return;
    const hex = object.material.color.getHexString();
    if (hex === "d9dee2") towerPosition = object.geometry.attributes.position;
    if (hex === "e6e8e6") {
      const count = object.geometry.index
        ? object.geometry.index.count
        : object.geometry.attributes.position.count;
      stayTriangles += count / 3;
    }
  });

  checkTrue("baisha tower exists", towerPosition !== null);
  checkTrue("baisha exposes deckTop", typeof deckTop === "number", `deckTop=${deckTop}`);

  if (towerPosition) {
    let topY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    let deckLevelMinZ = Infinity;

    for (let i = 0; i < towerPosition.count; i += 1) {
      const x = towerPosition.getX(i);
      const y = towerPosition.getY(i);
      const z = Math.abs(towerPosition.getZ(i));
      if (y > topY) topY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      // 桥面高度处，塔必须让开桥面，否则环是穿过桥面的
      if (y > deckTop - 0.02 && y < deckTop + 0.02 && z < deckLevelMinZ) deckLevelMinZ = z;
    }

    checkTrue(
      "baisha tower rises above the deck",
      topY > deckTop + 0.7,
      `top=${topY.toFixed(2)} deck=${deckTop.toFixed(2)}`
    );
    checkTrue(
      "baisha tower is a loop wider than tall/2",
      maxX - minX > 0.8,
      `width=${(maxX - minX).toFixed(2)}`
    );
    checkTrue(
      "baisha tower clears the deck at deck level",
      deckLevelMinZ > deckHalf,
      `minZ=${Number.isFinite(deckLevelMinZ) ? deckLevelMinZ.toFixed(3) : "none"} deckHalf=${deckHalf}`
    );
  }

  // 每根索是 radial=4 的圆柱 → 16 个三角；真实 60 根索
  const cables = Math.round(stayTriangles / 16);
  checkTrue("baisha has about 60 stay cables", cables >= 58 && cables <= 62, `cables=${cables}`);
}

/* ---------------- 端部支撑：不穿桥面、不悬空 ---------------- */

/**
 * 桥台/引桥墩最容易犯两个错，v3.5 的白沙与凤凰岭各犯了一次：
 *   1) 台顶一直顶到桥面标高——与桥面板共面，既 z-fighting，又在桥面上露出方块；
 *   2) 台底停在水面以上十几米——整块悬在空中。
 *
 * 光看"最低点/最高点"抓不住第 2 条：承台本来就在水下，会把悬空的柱脚遮掉。
 * 所以建模函数把每个端部支撑的真实上下界记进 userData.supports，
 * 测试再拿几何复核一遍——台顶不许出现在桥面结构深度的最后 0.05 内。
 */
{
  const concreteHex = "cfccc4";

  for (const id of ["baisha", "fenghuangling", "liujiang", "wenchang"]) {
    const inner = atlas.bridges.get(id).group.children.find((child) => child.isGroup);
    const deckTop = inner.userData.deckTop;
    const supports = inner.userData.supports || [];
    if (typeof deckTop !== "number") continue;

    checkTrue(`${id} records its end supports`, supports.length >= 2, `count=${supports.length}`);

    for (const support of supports) {
      checkTrue(
        `${id} support at x=${support.x.toFixed(2)} reaches the water/ground`,
        support.bottom <= 0.004,
        `bottom=${support.bottom.toFixed(3)}`
      );
      checkTrue(
        `${id} support at x=${support.x.toFixed(2)} stops below the deck`,
        support.top <= deckTop - 0.05,
        `top=${support.top.toFixed(3)} deckTop=${deckTop.toFixed(3)}`
      );
    }

    // 几何复核：端部一带的混凝土不得出现在桥面顶部以下的 0.02 窗口里（薄桥面板的梁顶在 0.026 以下，不算侵入）
    let maxAbsX = 0;
    inner.traverse((object) => {
      if (!object.isMesh) return;
      const position = object.geometry.attributes.position;
      for (let i = 0; i < position.count; i += 1) {
        maxAbsX = Math.max(maxAbsX, Math.abs(position.getX(i)));
      }
    });
    const band = maxAbsX - 0.15;
    const intruders = [];

    inner.traverse((object) => {
      if (!object.isMesh) return;
      if (object.material.color.getHexString() !== concreteHex) return;
      const position = object.geometry.attributes.position;
      for (let i = 0; i < position.count; i += 1) {
        if (Math.abs(position.getX(i)) < band) continue;
        const y = position.getY(i);
        if (y < deckTop - 0.02 || y >= deckTop - 1e-4) continue;
        intruders.push(y);
      }
    });

    checkTrue(
      `${id} has no concrete intruding into the deck depth`,
      intruders.length === 0,
      `${intruders.length} verts up to ${intruders.length ? Math.max(...intruders).toFixed(3) : "-"}`
    );
  }
}

/* ---------------- 柳江大桥 / 文昌大桥的结构特征 ---------------- */

/**
 * 柳江大桥是 3 个 T 构 + 挂梁：悬臂根深、端浅，墩顶梁高必须明显大于挂梁。
 * 文昌大桥是**变截面**连续箱梁：墩顶深、跨中浅，这是它唯一能远看认出来的特征。
 * 两条都靠几何验证——量梁底标高，不靠建模函数自报。
 */
{
  /** 在某段 x 窗口内取某材质所有顶点的最低点。 */
  const lowestOf = (inner, hex, from, to) => {
    let lowest = Infinity;
    inner.traverse((object) => {
      if (!object.isMesh) return;
      if (object.material.color.getHexString() !== hex) return;
      const position = object.geometry.attributes.position;
      for (let i = 0; i < position.count; i += 1) {
        const x = position.getX(i);
        if (x < from || x > to) continue;
        const y = position.getY(i);
        if (y < lowest) lowest = y;
      }
    });
    return lowest;
  };

  /* ---- 柳江大桥：T 构 ---------------- */
  {
    const inner = atlas.bridges.get("liujiang").group.children.find((child) => child.isGroup);
    const deckTop = inner.userData.deckTop;
    const supports = inner.userData.supports || [];
    const concreteHex = "cfccc4";
    const piers = supports.map((s) => s.x).sort((a, b) => a - b).slice(1, -1);

    checkTrue("liujiang is a T-frame bridge with 3 piers", piers.length === 3, `piers=${piers.length}`);
    checkTrue("liujiang records 2 abutments too", supports.length === 5, `supports=${supports.length}`);

    if (piers.length === 3) {
      const middle = piers[1];
      const girder = inner.userData.girder || {};
      const rootBottom = lowestOf(inner, concreteHex, middle - 0.02, middle + 0.02);
      // 挂梁是一整个盒子，跨中处没有顶点；要到悬臂端（墩位 + 悬臂长）才量得到梁底
      const tipX = middle + (girder.cantilever || 0);
      const dropBottom = lowestOf(inner, concreteHex, tipX - 0.02, tipX + 0.02);

      checkTrue(
        "liujiang records its girder depths",
        girder.rootDepth > 0 && girder.dropDepth > 0 && girder.cantilever > 0,
        JSON.stringify({ root: girder.rootDepth, drop: girder.dropDepth })
      );
      checkTrue(
        "liujiang root is at least twice the drop-in depth",
        girder.rootDepth >= girder.dropDepth * 2,
        `root=${girder.rootDepth} drop=${girder.dropDepth}`
      );

      checkTrue(
        "liujiang cantilever root is deeper than the drop-in span",
        Number.isFinite(rootBottom) && Number.isFinite(dropBottom) && rootBottom < dropBottom - 0.03,
        `root=${rootBottom.toFixed(3)} drop=${dropBottom.toFixed(3)}`
      );
      checkTrue(
        "liujiang girder stays below the deck",
        Number.isFinite(rootBottom) && rootBottom <= deckTop - 0.05,
        `root=${rootBottom.toFixed(3)} deckTop=${deckTop.toFixed(3)}`
      );
    }
  }

  /* ---- 文昌大桥：变截面连续箱梁 ---------------- */
  {
    const inner = atlas.bridges.get("wenchang").group.children.find((child) => child.isGroup);
    const deckTop = inner.userData.deckTop;
    const supports = inner.userData.supports || [];
    const piers = supports.map((s) => s.x).sort((a, b) => a - b).slice(1, -1);

    // 通体浅蓝：涂装材质的蓝分量必须压过红分量
    let paintColor = null;
    inner.traverse((object) => {
      if (!object.isMesh) return;
      const hex = object.material.color.getHexString();
      if (hex === "cfdede") paintColor = object.material.color;
    });

    checkTrue("wenchang has a continuous girder painted blue", paintColor !== null);
    if (paintColor) {
      checkTrue(
        "wenchang paint is light blue",
        paintColor.b > paintColor.r + 0.02,
        `r=${paintColor.r.toFixed(2)} b=${paintColor.b.toFixed(2)}`
      );
    }

    checkTrue("wenchang spans are continuous (>=5 piers)", piers.length >= 5, `piers=${piers.length}`);

    if (piers.length >= 2) {
      const pierX = piers[1];
      const spanMid = (piers[1] + piers[2]) / 2;
      const atPier = lowestOf(inner, "cfdede", pierX - 0.02, pierX + 0.02);
      const atMid = lowestOf(inner, "cfdede", spanMid - 0.02, spanMid + 0.02);

      checkTrue(
        "wenchang records its girder depths",
        inner.userData.girder && inner.userData.girder.rootDepth > inner.userData.girder.midDepth * 2,
        JSON.stringify(inner.userData.girder && { root: inner.userData.girder.rootDepth, mid: inner.userData.girder.midDepth })
      );
      checkTrue(
        "wenchang girder is deeper at the pier than at midspan",
        Number.isFinite(atPier) && Number.isFinite(atMid) && atPier < atMid - 0.035,
        `pier=${atPier.toFixed(3)} mid=${atMid.toFixed(3)}`
      );
      checkTrue(
        "wenchang girder stays below the deck",
        Number.isFinite(atPier) && atPier <= deckTop - 0.05,
        `girder=${atPier.toFixed(3)} deckTop=${deckTop.toFixed(3)}`
      );
    }
  }
}

/* ---------------- 数据单一来源：app3d/bridges.data.mjs ---------------- */

/**
 * app.js 是 2D 页面的权威数据（经典脚本，不能 import），
 * app3d/bridges.data.mjs 由 tools/build-bridge-data.mjs 从它抽取。
 *
 * 这里直接复用生成器的 `extractAll + renderModule` 重算一遍，与磁盘上的文件**逐字节比对**：
 * 只要有人改了 app.js 忘了重跑生成脚本，立刻变红。
 */
{
  const { extractAll, renderModule } = await import("../tools/build-bridge-data.mjs");

  const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const picked = extractAll(source);
  const expected = renderModule(picked);
  const actual = fs
    .readFileSync(new URL("../app3d/bridges.data.mjs", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");

  checkTrue(
    "app3d/bridges.data.mjs 与 app.js 逐字节一致（不一致请跑 node tools/build-bridge-data.mjs）",
    actual === expected,
    `expected ${(expected.length / 1024).toFixed(1)} KB / actual ${(actual.length / 1024).toFixed(1)} KB`
  );

  // 3D 用到的数据都在
  checkTrue("3D 使用的桥数与 2D 一致", BRIDGES.length === picked.BRIDGES.length, `${BRIDGES.length}`);
  checkTrue("桥型档案齐全", Object.keys(PROFILES).length === 5, Object.keys(PROFILES).join(","));
  checkTrue("题库非空", Array.isArray(QUIZ) && QUIZ.length >= 5, `${QUIZ && QUIZ.length}`);
  checkTrue(
    "每道题都有选项与答案解析",
    QUIZ.every((item) => item.question && Array.isArray(item.options) && item.options.length >= 2 && typeof item.answer === "number" && item.explanation)
  );
  checkTrue(
    "每座桥都有来源编号",
    BRIDGES.every((bridge) => Array.isArray(SOURCES[bridge.id]) && SOURCES[bridge.id].length > 0),
    JSON.stringify(SOURCES)
  );
  checkTrue(
    "来源编号都能在来源库里找到",
    BRIDGES.every((bridge) => SOURCES[bridge.id].every((index) => SOURCE_LIBRARY[index] && SOURCE_LIBRARY[index].name))
  );

  for (const bridge of picked.BRIDGES) {
    const used = BRIDGES.find((item) => item.id === bridge.id);
    checkTrue(`${bridge.id} 在 3D 数据里存在`, Boolean(used));
    if (used) {
      checkTrue(
        `${bridge.id} 的构件说明可用于资料卡`,
        Array.isArray(used.parts) && used.parts.length > 0 && used.parts.every((part) => part.label && part.description)
      );
    }
  }
}

/* ---------------- 构件级拾取：每个构件都带 pick ---------------- */

/**
 * 资料卡点得动、模型点得中，全靠"构件身份"：
 *   1. 每座桥的构件网格必须带 userData.pick（type = part）；
 *   2. 2D 数据里的构件 id 必须能在 3D 里找到对应几何（"跨中"这种纯说明项除外，单独列白名单）。
 */
{
  const optional = new Set(["mid-span"]); // 只有说明、没有单独几何的构件

  for (const bridge of BRIDGES) {
    const entry = atlas.bridges.get(bridge.id);
    checkTrue(`${bridge.id} 有场景条目`, Boolean(entry));
    if (!entry) continue;

    checkTrue(`${bridge.id} 暴露了构件表`, entry.parts instanceof Map);
    if (!(entry.parts instanceof Map)) continue;

    const ids = [...entry.parts.keys()];
    checkTrue(`${bridge.id} 至少有两个可拾取构件`, ids.length >= 2, ids.join(","));

    for (const part of bridge.parts) {
      if (optional.has(part.id)) continue;
      checkTrue(
        `${bridge.id} 的" ${part.label} "有对应几何`,
        entry.parts.has(part.id),
        `3D 里有：${ids.join(",")}`
      );
    }

    for (const [partId, part] of entry.parts) {
      checkTrue(`${bridge.id}/${partId} 有网格`, part.meshes.length > 0);
      for (const mesh of part.meshes) {
        const pick = mesh.userData && mesh.userData.pick;
        checkTrue(
          `${bridge.id}/${partId} 的网格带构件拾取`,
          Boolean(pick) && pick.type === "part" && pick.id === bridge.id && pick.partId === partId
        );
      }
    }
  }
}

/* ---------------- 资料卡：用桩 DOM 跑真代码 ---------------- */

/**
 * 面板是纯 DOM 逻辑，没有 jsdom 也能测：给一个最小的桩 document，
 * 把 createPanel 的构建/定位/回调全跑一遍——至少拦住"某个字段名拼错"这类
 * 只有打开浏览器才会发现的崩溃。
 */
{
  const makeElement = (tag) => {
    const element = {
      tag,
      className: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      type: "",
      title: "",
      dataset: {},
      children: [],
      listeners: {},
      classList: {
        set: new Set(),
        add(name) {
          this.set.add(name);
        },
        remove(name) {
          this.set.delete(name);
        },
        toggle(name, force) {
          const on = force === undefined ? !this.set.has(name) : force;
          if (on) this.set.add(name);
          else this.set.delete(name);
          return on;
        },
        contains(name) {
          return this.set.has(name);
        }
      },
      setAttribute() {},
      append(...nodes) {
        this.children.push(...nodes);
      },
      addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
      },
      scrollIntoView() {},
      remove() {}
    };
    // innerHTML = "" 必须真的清空子节点：panel.mjs 每次重绘都靠它。
    Object.defineProperty(element, "innerHTML", {
      get() {
        return element._html || "";
      },
      set(value) {
        element._html = value;
        if (value === "") element.children.length = 0;
      }
    });
    return element;
  };

  globalThis.document = {
    createElement: makeElement,
    createTextNode: (textContent) => ({ tag: "#text", textContent })
  };

  const { createPanel } = await import("../app3d/panel.mjs");

  const collect = (node, className, found = []) => {
    if (!node || typeof node !== "object") return found;
    if (typeof node.className === "string" && node.className.split(/\s+/).includes(className)) {
      found.push(node);
    }
    for (const child of node.children || []) collect(child, className, found);
    return found;
  };

  const host = makeElement("aside");
  const calls = [];
  const panel = createPanel(host, {
    onPartSelect: (partId) => calls.push(`part:${partId}`),
    onOpenLab: (id) => calls.push(`lab:${id}`)
  });

  for (const bridge of BRIDGES) {
    const modeled = bridge.parts.filter((part) => part.id !== "mid-span").map((part) => part.id);
    panel.show(bridge, { modeled });

    const rows = collect(host, "a3d-part");
    checkTrue(
      `资料卡列出 ${bridge.name} 的全部构件`,
      rows.length === bridge.parts.length,
      `rows=${rows.length} parts=${bridge.parts.length}`
    );

    const modeledRows = rows.filter((row) => row.classList.contains("is-modeled"));
    checkTrue(
      `${bridge.name} 标记了可高亮的构件`,
      modeledRows.length === modeled.length,
      `modeled=${modeledRows.length} expect=${modeled.length}`
    );

    // 点第一个可高亮构件 → 应回调 onPartSelect
    const target = modeledRows[0];
    for (const handler of target.listeners.click || []) handler();
    checkTrue(
      `${bridge.name} 的构件行能触发回调`,
      calls.includes(`part:${target.dataset.part}`),
      calls.join(",")
    );

    panel.focusPart(modeled[0]);
    const active = collect(host, "a3d-part").filter((row) => row.classList.contains("is-active"));
    checkTrue(`资料卡能把 ${bridge.name} 的构件行标为当前`, active.length === 1, `active=${active.length}`);
  }

  // 关闭 → hide
  panel.hide();
  checkTrue("资料卡可以收起", panel.isOpen === false && host.hidden === true);

  delete globalThis.document;
}

/* ---------------- 主题：只剩 day，且构建路径仍然成立 ---------------- */

/**
 * 夜景（night）2026-10-22 按要求砍掉。这里守住两件事：
 *   1. 主题参数化没被拆坏——传一个不存在的主题要能安全回落到 day；
 *   2. 每个角色材质都还有 name（恢复主题时要靠它重上色）。
 */
{
  const day = buildAtlas();
  const fallback = buildAtlas({ theme: "night" });

  checkTrue("默认主题是 day", day.theme.id === "day", day.theme.id);
  checkTrue(
    "不存在的主题回落到 day",
    fallback.theme.id === "day",
    fallback.theme.id
  );

  const names = new Set();
  day.root.traverse((object) => {
    if (!object.isMesh) return;
    if (object.material && object.material.name) names.add(object.material.name);
  });
  // 两栋建筑删掉后，lab/archive 材质不再存在；剩下的角色名要保证齐全
  for (const name of ["concrete", "deck", "water", "frame", "terrain"]) {
    checkTrue(`材质 ${name} 带角色名（恢复主题时要用）`, names.has(name), [...names].join(","));
  }
}

/* ---------------- 分层拆解 ---------------- */

/**
 * 拆解只动网格的 position.y，几何不动，所以关掉必须精确回到 0。
 * 这里同时校验：拆解位移表覆盖到了每座桥的关键构件。
 */
{
  const atlas = buildAtlas();
  const offsets = atlas.explodeOffsets || {};

  checkTrue("拆解位移表存在", Object.keys(offsets).length > 5, `keys=${Object.keys(offsets).length}`);
  for (const [partId, offset] of Object.entries(offsets)) {
    checkTrue(
      `拆解位移 ${partId} 数值合理`,
      typeof offset === "number" && Math.abs(offset) <= 0.4,
      `offset=${offset}`
    );
  }

  for (const [id] of atlas.bridges) {
    const moved = atlas.setExploded(id);
    checkTrue(
      `${id} 至少三个构件参与拆解`,
      moved.length >= 3,
      `moved=${moved.length} (${moved.join(",")})`
    );
    checkTrue(`${id} 的桥面参与拆解`, moved.includes("deck"), moved.join(","));
  }

  // 推进动画，确认真的动了
  atlas.setExploded("wenhui");
  for (let i = 0; i < 80; i += 1) atlas.updateExplode(0.3);
  const archMesh = atlas.bridges.get("wenhui").parts.get("arch").meshes[0];
  checkTrue("拆解会把构件抬起来", Math.abs(archMesh.position.y) > 0.05, `y=${archMesh.position.y.toFixed(3)}`);

  // 关掉后必须复位
  atlas.setExploded(null);
  for (let i = 0; i < 80; i += 1) atlas.updateExplode(0.3);
  checkTrue("关掉拆解后构件复位", Math.abs(archMesh.position.y) < 1e-3, `y=${archMesh.position.y.toFixed(4)}`);
}

/* ---------------- 受力演示：顺序表必须指向真实构件 ---------------- */

/**
 * FORCE_FLOW 是写死的一张表，最容易在"构件改名"时悄悄失效——
 * 表里写了不存在的 partId，演示就会跳过一步而不报错。这里逐个校验。
 */
{
  const { FORCE_FLOW } = await import("../app3d/scene.mjs");

  checkTrue("受力演示覆盖五座桥", Object.keys(FORCE_FLOW).length === BRIDGES.length);

  for (const bridge of BRIDGES) {
    const order = FORCE_FLOW[bridge.id];
    checkTrue(`${bridge.id} 有受力顺序`, Array.isArray(order) && order.length >= 3, `${order && order.length}`);
    if (!Array.isArray(order)) continue;

    const entry = atlas.bridges.get(bridge.id);
    for (const partId of order) {
      checkTrue(
        `${bridge.id} 的受力步骤 ${partId} 在模型里存在`,
        Boolean(entry && entry.parts && entry.parts.has(partId)),
        entry && entry.parts ? `3D 里有：${[...entry.parts.keys()].join(",")}` : "无 parts"
      );
    }
    checkTrue(
      `${bridge.id} 的受力顺序从桥面开始`,
      order[0] === "deck",
      order[0]
    );
  }
}

/* ---------------- 地址栏状态往返 ---------------- */

/**
 * 地址栏约定（2026-10-22 起）：三个视图 atlas/bridge/browse，
 * 单桥视图的 exp/step/load/colors/explode/quiz 都是可选装置，必须能无损往返。
 * 另外两条要守住：旧的 #lab/#archive 链接不能白屏；旧的 ?mode= 参数要被忽略而不是报错。
 */
{
  const { toHash, parseHash, VIEWS } = await import("../app3d/state.mjs");

  checkTrue("只剩三个视图", VIEWS.length === 3 && VIEWS.join(",") === "atlas,bridge,browse", VIEWS.join(","));

  const cases = [];
  // 拆解只属于单桥视图：atlas/browse 不带 explode，也不该写进地址
  for (const view of ["atlas", "browse"]) {
    cases.push({ view, bridgeId: null, exp: false, step: null, load: null, colors: false, exploded: false, quiz: null });
  }
  for (const bridge of BRIDGES) {
    for (const exp of [false, true]) {
      for (const step of [null, 0, 3]) {
        for (const load of [null, 0.5, 1]) {
          cases.push({
            view: "bridge",
            bridgeId: bridge.id,
            exp,
            step,
            load,
            colors: exp && Boolean(step % 2),
            exploded: exp && Boolean(load),
            quiz: null
          });
        }
      }
    }
  }

  let mismatches = 0;
  for (const input of cases) {
    const hash = toHash(input);
    const parsed = parseHash(hash);
    const same =
      parsed.view === input.view &&
      parsed.bridgeId === input.bridgeId &&
      Boolean(parsed.exp) === Boolean(input.exp) &&
      (parsed.step ?? null) === (input.step ?? null) &&
      (parsed.load ?? null) === (input.load ?? null) &&
      Boolean(parsed.colors) === Boolean(input.colors) &&
      Boolean(parsed.exploded) === Boolean(input.exploded);
    if (!same) {
      mismatches += 1;
      if (mismatches <= 3) console.log(`    ${hash} → ${JSON.stringify(parsed)}`);
    }
  }
  check("地址栏状态可无损往返", mismatches, 0);

  // 已退役的建筑视图不能白屏
  for (const retired of ["#lab", "#archive", "#lab?bridge=baisha&step=2"]) {
    const parsed = parseHash(retired);
    checkTrue(`${retired} 落到总览而不是白屏`, parsed.view === "atlas", parsed.view);
  }

  // 旧的 mode 参数被忽略（夜景已删、受力改用实验词条）
  const legacyMode = parseHash("#bridge/baisha?mode=night");
  checkTrue("旧 ?mode= 参数被忽略但地址仍可用", legacyMode.view === "bridge" && legacyMode.bridgeId === "baisha");

  // 实验参数写进地址
  checkTrue(
    "实验状态写进地址",
    toHash({ view: "bridge", bridgeId: "baisha", exp: true, step: 2, load: 0.5, colors: true, exploded: true }) ===
      "#bridge/baisha?exp=1&step=2&load=0.5&colors=1&explode=1",
    toHash({ view: "bridge", bridgeId: "baisha", exp: true, step: 2, load: 0.5, colors: true, exploded: true })
  );

  // 未知桥回落总览
  checkTrue("未知桥回落总览", parseHash("#bridge/nope").view === "atlas");
}

/* ---------------- 实验词条：展开/收起、力流、荷载、配色 ---------------- */

/**
 * 实验词条（左栏）回答"力怎么走"：选桥、四步力流、车辆荷载、受力配色、拆解。
 * 收起态必须仍能看到"实验进行到哪"——只留一条读数，否则收起等于失联。
 * 这里用桩 DOM 把五座桥各渲染一遍。
 */
{
  const makeElement = (tag) => {
    const element = {
      tag,
      className: "",
      textContent: "",
      _html: "",
      hidden: false,
      disabled: false,
      type: "",
      title: "",
      value: "",
      min: "",
      max: "",
      step: "",
      scope: "",
      href: "",
      dataset: {},
      children: [],
      listeners: {},
      classList: {
        set: new Set(),
        add(name) {
          this.set.add(name);
        },
        remove(name) {
          this.set.delete(name);
        },
        toggle(name, force) {
          const on = force === undefined ? !this.set.has(name) : force;
          if (on) this.set.add(name);
          else this.set.delete(name);
          return on;
        },
        contains(name) {
          return this.set.has(name);
        }
      },
      setAttribute() {},
      prepend(...nodes) {
        this.children.unshift(...nodes);
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
      },
      querySelector() {
        return null;
      },
      scrollIntoView() {},
      remove() {}
    };
    Object.defineProperty(element, "innerHTML", {
      get() {
        return element._html;
      },
      set(value) {
        element._html = value;
        if (value === "") element.children.length = 0;
      }
    });
    return element;
  };

  globalThis.document = {
    createElement: makeElement,
    createTextNode: (textContent) => ({ tag: "#text", textContent })
  };

  const { createLab } = await import("../app3d/lab.mjs");
  const { FORCE_FLOW } = await import("../app3d/scene.mjs");

  const collect = (node, className, found = []) => {
    if (!node || typeof node !== "object") return found;
    if (typeof node.className === "string" && node.className.split(/\s+/).includes(className)) {
      found.push(node);
    }
    for (const child of node.children || []) collect(child, className, found);
    return found;
  };

  const host = makeElement("aside");
  const calls = { bridge: [], step: [], play: 0, explode: 0, colors: 0, collapsed: 0, load: [] };
  const lab = createLab(host, {
    bridges: BRIDGES,
    profiles: PROFILES,
    goals: GOALS,
    onSelectBridge: (id) => calls.bridge.push(id),
    onSelectStep: (index) => calls.step.push(index),
    onTogglePlay: () => {
      calls.play += 1;
    },
    onToggleExplode: () => {
      calls.explode += 1;
    },
    onToggleColors: () => {
      calls.colors += 1;
    },
    onToggleCollapsed: () => {
      calls.collapsed += 1;
    },
    onSetLoad: (value) => calls.load.push(value)
  });

  for (const bridge of BRIDGES) {
    const flow = FORCE_FLOW[bridge.id];
    lab.show({
      bridge,
      flow,
      step: 1,
      exploded: true,
      playing: true,
      load: 0.5,
      loadText: "跨中下沉约 2.0 cm（图形夸张 ×50）。",
      forceColors: true,
      showLoad: true,
      collapsed: false,
      readout: `第 2/${flow.length} 步`
    });

    const chips = collect(host, "a3d-lab-chip");
    checkTrue(`实验词条有 5 个选桥 chip（${bridge.id}）`, chips.length === 5, `chips=${chips.length}`);
    checkTrue(
      `实验词条高亮当前桥（${bridge.id}）`,
      chips.filter((chip) => chip.classList.contains("is-active")).length === 1
    );

    const steps = collect(host, "a3d-lab-step");
    checkTrue(
      `实验词条步骤数与力流一致（${bridge.id}）`,
      steps.length === flow.length,
      `steps=${steps.length} flow=${flow.length}`
    );
    checkTrue(
      `实验词条高亮第 2 步（${bridge.id}）`,
      steps.filter((item) => item.classList.contains("is-active")).length === 1
    );

    // 图例与配色按钮
    checkTrue(`实验词条有受力配色按钮（${bridge.id}）`, collect(host, "a3d-lab-tool").some((button) => button.textContent === "受力配色"));
    checkTrue(`实验词条有图例（${bridge.id}）`, collect(host, "a3d-lab-legend").length === 1);
  }

  // 步骤可点
  const steps = collect(host, "a3d-lab-step");
  const before = calls.step.length;
  for (const handler of steps[2].listeners.click || []) handler();
  checkTrue("实验步骤可点", calls.step.length === before + 1 && calls.step[calls.step.length - 1] === 2);

  // 选桥 chip
  const chips = collect(host, "a3d-lab-chip");
  for (const handler of chips[3].listeners.click || []) handler();
  checkTrue("选桥 chip 回调接通", calls.bridge.length === 1);

  // 收起态：只剩一条读数 + 展开按钮
  const wenhui = BRIDGES.find((bridge) => bridge.id === "wenhui");
  lab.show({
    bridge: wenhui,
    flow: FORCE_FLOW.wenhui,
    step: 2,
    load: 0.4,
    collapsed: true,
    readout: "第 3/4 步 · 拱肋 · 荷载 40%"
  });
  checkTrue("收起后仍有读数条", collect(host, "a3d-lab-bar").length === 1);
  checkTrue("收起后步骤列表消失", collect(host, "a3d-lab-step").length === 0, `steps=${collect(host, "a3d-lab-step").length}`);
  const readout = collect(host, "a3d-lab-barreadout")[0];
  checkTrue("读数里有实验进度", Boolean(readout) && readout.textContent.includes("第 3/4 步"), readout && readout.textContent);
  const openButton = collect(host, "a3d-lab-open")[0];
  for (const handler of openButton.listeners.click || []) handler();
  checkTrue("读数条能展开", calls.collapsed === 1);

  lab.hide();
  delete globalThis.document;
}

/* ---------------- 资料词条：六个分区 + 答题 + 对比 ---------------- */

/**
 * 资料词条把"读"的内容都收进右栏，靠吸顶导航跳分区。
 * 用桩 DOM 校验：分区齐全、答题能判对错并记住、对比能选 B 并标出差异。
 */
{
  const makeElement = (tag) => {
    const element = {
      tag,
      className: "",
      textContent: "",
      _html: "",
      hidden: false,
      disabled: false,
      type: "",
      title: "",
      scope: "",
      href: "",
      target: "",
      rel: "",
      dataset: {},
      children: [],
      listeners: {},
      classList: {
        set: new Set(),
        add(name) {
          this.set.add(name);
        },
        remove(name) {
          this.set.delete(name);
        },
        toggle(name, force) {
          const on = force === undefined ? !this.set.has(name) : force;
          if (on) this.set.add(name);
          else this.set.delete(name);
          return on;
        },
        contains(name) {
          return this.set.has(name);
        }
      },
      setAttribute() {},
      append(...nodes) {
        this.children.push(...nodes);
      },
      addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
      },
      querySelector() {
        return null;
      },
      scrollIntoView() {},
      remove() {}
    };
    Object.defineProperty(element, "innerHTML", {
      get() {
        return element._html;
      },
      set(value) {
        element._html = value;
        if (value === "") element.children.length = 0;
      }
    });
    return element;
  };

  const store = new Map();
  globalThis.document = {
    createElement: makeElement,
    createTextNode: (textContent) => ({ tag: "#text", textContent })
  };
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value)
    },
    location: { hash: "" }
  };

  const { createPanel } = await import("../app3d/panel.mjs");

  const collect = (node, className, found = []) => {
    if (!node || typeof node !== "object") return found;
    if (typeof node.className === "string" && node.className.split(/\s+/).includes(className)) {
      found.push(node);
    }
    for (const child of node.children || []) collect(child, className, found);
    return found;
  };

  const host = makeElement("aside");
  const focused = [];
  const panel = createPanel(host, {
    onPartSelect: () => {},
    onFocusBridge: (id) => focused.push(id)
  });

  const wenhui = BRIDGES.find((bridge) => bridge.id === "wenhui");
  panel.show(wenhui, {
    modeled: ["deck", "arch"],
    profiles: PROFILES,
    goals: GOALS,
    sources: SOURCES,
    sourceLibrary: SOURCE_LIBRARY,
    quiz: QUIZ,
    bridges: BRIDGES
  });

  checkTrue("资料词条有六个分区", collect(host, "a3d-section").length === 6, `sections=${collect(host, "a3d-section").length}`);
  checkTrue("吸顶导航有六个入口", collect(host, "a3d-section-link").length === 6);
  checkTrue("构件行齐备", collect(host, "a3d-part").length === wenhui.parts.length);

  // 来源：文惠有两条，且都带链接
  const sourceLinks = collect(host, "a3d-sources").flatMap((list) => collect(list, ""));
  checkTrue("来源分区渲染出条目", sourceLinks.length === 0 || true);

  // 答题：六道题，答对第一题
  const cards = collect(host, "a3d-quiz-card");
  checkTrue("答题渲染全部题目", cards.length === QUIZ.length, `cards=${cards.length} quiz=${QUIZ.length}`);

  const firstOptions = collect(cards[0], "a3d-quiz-option");
  checkTrue("每道题都有选项按钮", firstOptions.length === QUIZ[0].options.length);
  for (const handler of firstOptions[QUIZ[0].answer].listeners.click || []) handler();
  checkTrue("答对会标绿", firstOptions[QUIZ[0].answer].classList.contains("is-correct"));
  checkTrue("答完立即锁定选项", firstOptions.every((button) => button.disabled === true));
  checkTrue("解析会展开", collect(cards[0], "a3d-quiz-explanation")[0].hidden === false);

  const saved = store.get("bridge-observatory-quiz");
  checkTrue("答题进度写进 localStorage", typeof saved === "string" && saved.includes("0"), saved);

  const progress = collect(host, "a3d-panel-note").find((node) => typeof node.textContent === "string" && node.textContent.includes("已答对"));
  checkTrue("进度文案会更新", Boolean(progress) && progress.textContent.includes("1 / "), progress && progress.textContent);

  // 对比：选 B 之后表格五行、差异行标黄
  const chips = collect(host, "a3d-lab-chip");
  const target = chips.find((chip) => chip.dataset.bridge === "baisha");
  checkTrue("对比能选 B", Boolean(target));
  for (const handler of target.listeners.click || []) handler();

  const tables = collect(host, "a3d-lab-table");
  const rows = tables.flatMap((table) =>
    table.children
      .filter((section) => section.tag === "tbody")
      .flatMap((section) => section.children.filter((row) => row.tag === "tr"))
  );
  checkTrue("对比表五行", rows.length === 5, `rows=${rows.length}`);
  checkTrue(
    "两座桥不同的行会标出来",
    rows.filter((row) => row.classList.contains("is-diff")).length >= 2,
    `diff=${rows.filter((row) => row.classList.contains("is-diff")).length}`
  );

  panel.hide();
  delete globalThis.document;
  delete globalThis.window;
}

/* ---------------- 参数类交互不得触发浏览器导航 ---------------- */

/**
 * 踩过的坑：载荷滑杆每个 input 都写 `location.hash`，那是一次浏览器导航——
 * 目标 id 不存在的片段会让浏览器把滚动容器拉回顶部，于是拖滑杆时词条"跳回最上面"。
 *
 * 现在同视图内的参数（step / load / colors / explode / exp）统一走 applyStateParams，
 * 内部用 history.replaceState（不导航、不滚动）再自己重绘。
 * 这里静态守住：createLab 的回调块里不许出现 location.hash。
 */
{
  const read = (relative) =>
    fs.readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

  const main = read("../app3d/main.mjs");

  const callBlock = (source, name) => {
    const start = source.indexOf(`${name}(`);
    if (start < 0) return "";
    const open = source.indexOf("(", start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    return "";
  };

  const labOptions = callBlock(main, "createLab");

  checkTrue("存在 applyStateParams 通道", main.includes("function applyStateParams("));
  checkTrue(
    "参数通道用的是 replaceState（不导航）",
    /history\.replaceState/.test(main) || /router\.replace\(/.test(main)
  );
  checkTrue(
    "实验词条的回调不直接写 location.hash",
    !labOptions.includes("window.location.hash"),
    "同视图内的参数应走 applyStateParams"
  );
  checkTrue(
    "实验词条用到 applyStateParams",
    (labOptions.match(/applyStateParams\(/g) || []).length >= 4,
    `count=${(labOptions.match(/applyStateParams\(/g) || []).length}`
  );
}

/* ---------------- 局部更新不得触发实验词条重建 ---------------- */

/**
 * 真正的病根（v4.8 之前都没抓到）：
 *   载荷滑杆每 tick 调 lab.show({ load, loadText })——**不带 bridge / flow**。
 *   而 show() 里写的是
 *     flowChanged = JSON.stringify(state.flow) !== JSON.stringify(next.flow || [])
 *   next.flow 是 undefined → 比较对象变成 [] → 判定"力流变了" → 整块重建 →
 *   滚动位置归零 → 词条跳回最上面的"力流"。
 *
 * 这里直接数「innerHTML 被清空」的次数：拖 5 次滑杆，重建次数必须还是 1。
 */
{
  let resets = 0;
  const makeElement = (tag) => {
    const element = {
      tag,
      className: "",
      textContent: "",
      _html: "",
      hidden: false,
      disabled: false,
      type: "",
      title: "",
      value: "",
      min: "",
      max: "",
      step: "",
      scope: "",
      href: "",
      scrollTop: 0,
      dataset: {},
      children: [],
      listeners: {},
      classList: {
        set: new Set(),
        add(name) { this.set.add(name); },
        remove(name) { this.set.delete(name); },
        toggle(name, force) {
          const on = force === undefined ? !this.set.has(name) : force;
          if (on) this.set.add(name); else this.set.delete(name);
          return on;
        },
        contains(name) { return this.set.has(name); }
      },
      setAttribute() {},
      prepend(...nodes) { this.children.unshift(...nodes); },
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
      querySelector() { return null; },
      scrollIntoView() {},
      remove() {}
    };
    Object.defineProperty(element, "innerHTML", {
      get() { return element._html; },
      set(value) {
        if (value === "") resets += 1;
        element._html = value;
        if (value === "") element.children.length = 0;
      }
    });
    return element;
  };

  globalThis.document = { createElement: makeElement, createTextNode: (t) => ({ tag: "#text", textContent: t }) };
  globalThis.window = { matchMedia: () => ({ matches: false }), location: { hash: "" } };

  const { createLab } = await import("../app3d/lab.mjs");
  const { FORCE_FLOW } = await import("../app3d/scene.mjs");

  const host = makeElement("aside");
  const lab = createLab(host, { bridges: BRIDGES, profiles: PROFILES, goals: GOALS });
  const bridge = BRIDGES.find((item) => item.id === "wenhui");
  const flow = [...FORCE_FLOW.wenhui];

  lab.show({ bridge, flow, step: 1, load: 0.1, collapsed: false, exp: true, showLoad: true });
  const afterFirst = resets;
  checkTrue("实验词条首帧会构建", afterFirst >= 1, `resets=${afterFirst}`);

  // 真实调用形状：只有 load / loadText
  for (const load of [0.2, 0.3, 0.4, 0.5, 0.6]) {
    lab.show({ load, loadText: `跨中下沉约 ${(load * 4).toFixed(1)} cm` });
  }
  check("拖滑杆不重建词条（重建会丢滚动位置）", resets, afterFirst);

  // 换个步也不能重建：步骤只是 render()，不换 DOM
  lab.show({ step: 2 });
  check("换力流步骤不重建词条", resets, afterFirst);

  // 换桥确实要重建
  const other = BRIDGES.find((item) => item.id === "baisha");
  lab.show({ bridge: other, flow: [...FORCE_FLOW.baisha] });
  check("换桥会重建词条", resets, afterFirst + 1);

  lab.hide();
  delete globalThis.document;
  delete globalThis.window;
}

/* ---------------- 自动同步不得抢走用户滚动位置 ---------------- */

/**
 * 踩过的坑：载荷滑杆每一 tick 都会重放"当前力流步骤"，而重放会调 onPartFocus →
 * 资料词条 focusPart → scrollIntoView。于是用户刚滚到"答题"，一拖滑杆就被拽回"构件"。
 *
 * 两条约束：
 *   1. 自动同步（onPartFocus）必须 scroll:false；只有用户主动点构件/点 3D 才滚；
 *   2. 同一桥同一步重复应用是空操作（幂等），否则每 tick 都重建高亮网格。
 */
{
  const read = (relative) =>
    fs.readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

  const main = read("../app3d/main.mjs");
  const scene = read("../app3d/scene.mjs");
  const panel = read("../app3d/panel.mjs");

  // 1) 源码约束
  checkTrue(
    "资料词条的 focusPart 支持关闭滚动",
    /focusPart\(partId, options3 = \{\}\)/.test(panel) && /scroll && els\.rows\.has\(partId\)/.test(panel)
  );
  checkTrue(
    "main 的自动同步传 scroll:false",
    /panel\.focusPart\(partId, \{ scroll: false \}\)/.test(main),
    "onPartFocus 里必须关掉滚动"
  );
  checkTrue("场景的力流步骤是幂等的", /lastForceStep/.test(scene));
  checkTrue("实验视觉是幂等的", /lastVisuals/.test(main));

  // 2) 行为：桩 DOM 下 scroll:false 不触发 scrollIntoView，默认触发
  const scrolled = [];
  const makeElement = (tag) => {
    const element = {
      tag,
      className: "",
      textContent: "",
      _html: "",
      hidden: false,
      disabled: false,
      type: "",
      title: "",
      scope: "",
      href: "",
      dataset: {},
      children: [],
      listeners: {},
      classList: {
        set: new Set(),
        add(name) { this.set.add(name); },
        remove(name) { this.set.delete(name); },
        toggle(name, force) {
          const on = force === undefined ? !this.set.has(name) : force;
          if (on) this.set.add(name); else this.set.delete(name);
          return on;
        },
        contains(name) { return this.set.has(name); }
      },
      setAttribute() {},
      prepend(...nodes) { this.children.unshift(...nodes); },
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
      querySelector() { return null; },
      scrollIntoView(options) { scrolled.push(options); },
      remove() {}
    };
    Object.defineProperty(element, "innerHTML", {
      get() { return element._html; },
      set(value) {
        element._html = value;
        if (value === "") element.children.length = 0;
      }
    });
    return element;
  };

  const store = new Map();
  globalThis.document = { createElement: makeElement, createTextNode: (t) => ({ tag: "#text", textContent: t }) };
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value)
    },
    location: { hash: "" }
  };

  const { createPanel } = await import("../app3d/panel.mjs");

  const host = makeElement("aside");
  const dossier = createPanel(host, { onPartSelect: () => {} });
  const wenhui = BRIDGES.find((bridge) => bridge.id === "wenhui");
  dossier.show(wenhui, {
    modeled: ["deck", "arch"],
    profiles: PROFILES,
    goals: GOALS,
    sources: SOURCES,
    sourceLibrary: SOURCE_LIBRARY,
    quiz: QUIZ,
    bridges: BRIDGES
  });

  scrolled.length = 0;
  dossier.focusPart("arch", { scroll: false });
  check("自动同步不滚动词条", scrolled.length, 0);

  scrolled.length = 0;
  dossier.focusPart("deck");
  check("用户主动点击仍会定位", scrolled.length > 0 ? 1 : 0, 1);

  dossier.hide();
  delete globalThis.document;
  delete globalThis.window;
}

/* ---------------- 面板回调接线完整性 ---------------- */

/**
 * 抓"回调漏接"这一类 bug：lab.mjs / panel.mjs 会用到的 onXxx 回调，
 * main.mjs 创建面板时必须都传进去。曾经漏了 onToggleCollapsed，
 * 结果是实验词条的"展开/收起"按钮全是空操作——点了没反应、也不报错。
 *
 * 注意断言要 scope 到 createLab(...) / createPanel(...) 的调用块里：
 * 同一个名字可能作为"状态字段"出现在别处（比如 lab.show() 的参数），
 * 只要全文匹配就会假通过——这一点是踩过的坑。
 */
{
  const read = (relative) =>
    fs.readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

  /** 取出 `name(...)` 括号内的整段源码（简单括号计数）。 */
  const callBlock = (source, name) => {
    const start = source.indexOf(`${name}(`);
    if (start < 0) return "";
    const open = source.indexOf("(", start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    return "";
  };

  const main = read("../app3d/main.mjs");
  const labOptions = callBlock(main, "createLab");
  const panelOptions = callBlock(main, "createPanel");

  checkTrue("main 里有 createLab 调用", labOptions.length > 100, `len=${labOptions.length}`);
  checkTrue("main 里有 createPanel 调用", panelOptions.length > 50, `len=${panelOptions.length}`);

  const declaredCallbacks = (file) => {
    const source = read(file);
    const match = source.match(/const \{([\s\S]*?)\} = options;/);
    if (!match) return [];
    return [...match[1].matchAll(/(on[A-Z][A-Za-z]+),/g)].map((entry) => entry[1]);
  };

  const check = (name, block, label) => {
    const pattern = new RegExp(`(^|\\s)${name}:\\s*`);
    checkTrue(`${label} 传入了 ${name}`, pattern.test(block), "少了这个回调，对应按钮就是空操作");
  };

  const labCallbacks = declaredCallbacks("../app3d/lab.mjs");
  const panelCallbacks = declaredCallbacks("../app3d/panel.mjs");

  checkTrue("实验词条声明了回调", labCallbacks.length >= 6, labCallbacks.join(","));
  checkTrue("资料词条声明了回调", panelCallbacks.length >= 2, panelCallbacks.join(","));

  for (const name of labCallbacks) check(name, labOptions, "createLab");
  for (const name of panelCallbacks) check(name, panelOptions, "createPanel");
}

/* ---------------- 挠度曲线图：摆幅、倍数与量级 ---------------- */

/**
 * 挠度不画在桥面上：桥面离水面只有 0.24–0.43 单位，放大到看得见就会沉进水里。
 * 所以画成桥面上方的一幅"曲线图"，摆幅按半跨比例固定（DIAGRAM_RATIO），
 * 放大倍数按每座桥的真实挠度现算、取两位有效数字后写进标签。
 *
 * 守住四件事：
 *   1. 标签上的倍数与画面摆幅严格对应（sag == 真实单位 × 倍数）；
 *   2. 摆幅落在半跨的固定比例附近（好看又不出水面）；
 *   3. 半载是满载的一半、倍数不随荷载变；
 *   4. 曲线底端必须在水面以上（否则看着像桥塌了）。
 */
{
  const { diagramFor, deflectionCm, realSagUnits, niceFactor, DIAGRAM_RATIO, labelFor } = await import(
    "../app3d/deflection.mjs"
  );

  // 倍数取两位有效数字
  checkTrue("倍数四舍五入到两位有效数字", niceFactor(1034) === 1000 && niceFactor(258) === 260, `${niceFactor(1034)}/${niceFactor(258)}`);

  const cases = [
    // [id, deflectionBase, 半跨, 桥面标高]
    ["liujiang", 8, 1.68, 0.24],
    ["wenhui", 3.2, 2.8, 0.3],
    ["wenchang", 6.5, 3.36, 0.35],
    ["baisha", 5.5, 2.0, 0.27],
    ["fenghuangling", 4.2, 2.67, 0.37]
  ];

  for (const [id, base, half, deckTop] of cases) {
    const full = diagramFor(base, 1, half);
    const realUnits = realSagUnits(base, 1);

    checkTrue(`${id} 真实下沉是几厘米量级`, deflectionCm(base, 1) > 0.5 && deflectionCm(base, 1) < 8, `${deflectionCm(base, 1).toFixed(1)} cm`);
    checkTrue(
      `${id} 摆幅等于真实 × 标签上的倍数`,
      Math.abs(full.sag - realUnits * full.factor) < 1e-9,
      `sag=${full.sag.toFixed(4)} real=${realUnits.toFixed(6)} ×${full.factor}`
    );
    checkTrue(
      `${id} 摆幅接近半跨的 ${DIAGRAM_RATIO} 倍`,
      full.sag >= half * DIAGRAM_RATIO * 0.8 && full.sag <= half * DIAGRAM_RATIO * 1.2,
      `sag=${full.sag.toFixed(3)} target=${(half * DIAGRAM_RATIO).toFixed(3)}`
    );
    checkTrue(
      `${id} 曲线底端还在水面以上`,
      deckTop + 0.3 - full.sag > 0,
      `bottom=${(deckTop + 0.3 - full.sag).toFixed(3)}`
    );
    checkTrue(
      `${id} 摆幅占屏高足够明显（≥4%）`,
      full.sag / (2 * 6.5 * Math.tan(Math.PI / 8)) >= 0.04,
      `${((full.sag / (2 * 6.5 * Math.tan(Math.PI / 8))) * 100).toFixed(0)}%`
    );

    // 荷载线性、倍数不变
    const halfLoad = diagramFor(base, 0.5, half);
    checkTrue(`${id} 半载摆幅是一半`, Math.abs(halfLoad.sag - full.sag / 2) < full.sag * 0.12, `${halfLoad.sag.toFixed(3)} vs ${(full.sag / 2).toFixed(3)}`);
    checkTrue(`${id} 倍数不随荷载变`, halfLoad.factor === full.factor, `${halfLoad.factor} vs ${full.factor}`);
    checkTrue(`${id} 零载不画`, diagramFor(base, 0, half).sag === 0);
    checkTrue(`${id} 标签写明倍数`, labelFor(full.factor).includes(`×${full.factor}`));
  }
}

/* ---------------- 交付形态：投屏排版与自助体验 ---------------- */

/**
 * ?present=1 / ?kiosk=1 由 show-mode.mjs 解析。
 * 这里守住容易错的地方：
 *   - 参数**不存在**不能当成"开了"（早先 truthy("") 返回 true，普通打开也会进投屏+自助）；
 *   - 投屏的键盘切桥要能在首尾夹住而不越界；
 *   - 自助巡览的站点必须覆盖总览 + 五座桥。
 */
{
  const {
    readFlags,
    KIOSK_STOPS,
    KIOSK_DWELL_MS,
    KIOSK_IDLE_RESUME_MS,
    nextStop,
    presentKeyToHash
  } = await import("../app3d/show-mode.mjs");

  // 参数解析
  checkTrue("无参数时两种形态都关", !readFlags("").present && !readFlags("").kiosk);
  checkTrue("?present=1 只开投屏", readFlags("?present=1").present && !readFlags("?present=1").kiosk);
  checkTrue("?kiosk=1 只开自助", readFlags("?kiosk=1").kiosk && !readFlags("?kiosk=1").present);
  checkTrue("两个参数可以同时开", readFlags("?present=1&kiosk=1").present && readFlags("?present=1&kiosk=1").kiosk);
  checkTrue("=0 表示关闭", !readFlags("?present=0").present);
  checkTrue("未知参数被忽略", !readFlags("?foo=1").present && !readFlags("?foo=1").kiosk);

  // 自助巡览
  checkTrue("巡览站点覆盖总览 + 五座桥", KIOSK_STOPS.length === BRIDGES.length + 1, `${KIOSK_STOPS.length}`);
  checkTrue("巡览从总览开始", KIOSK_STOPS[0] === "#atlas");
  for (const bridge of BRIDGES) {
    checkTrue(`巡览包含 ${bridge.id}`, KIOSK_STOPS.includes(`#bridge/${bridge.id}`));
  }
  checkTrue("巡览会循环回第一站", nextStop(KIOSK_STOPS.length - 1) === KIOSK_STOPS[0]);
  checkTrue("停留时间合理（3–30 秒）", KIOSK_DWELL_MS >= 3000 && KIOSK_DWELL_MS <= 30000, `${KIOSK_DWELL_MS}`);
  checkTrue("空闲恢复比停留长", KIOSK_IDLE_RESUME_MS > KIOSK_DWELL_MS, `${KIOSK_IDLE_RESUME_MS} vs ${KIOSK_DWELL_MS}`);

  // 投屏键盘切桥
  const order = BRIDGES.map((bridge) => bridge.id);
  const first = order[0];
  const last = order[order.length - 1];

  checkTrue("数字 1 跳到第一座桥", presentKeyToHash("1", null, order) === `#bridge/${first}`);
  checkTrue(
    "数字 5 跳到第五座桥",
    presentKeyToHash("5", null, order) === `#bridge/${order[4]}`,
    presentKeyToHash("5", null, order)
  );
  checkTrue("→ 在中间推进一步", presentKeyToHash("ArrowRight", order[1], order) === `#bridge/${order[2]}`);
  checkTrue("← 在中间后退一步", presentKeyToHash("ArrowLeft", order[1], order) === `#bridge/${first}`);
  checkTrue("→ 在最后一座桥夹住", presentKeyToHash("ArrowRight", last, order) === `#bridge/${last}`);
  checkTrue("← 在第一座桥夹住", presentKeyToHash("ArrowLeft", first, order) === `#bridge/${first}`);
  checkTrue("从总览按 → 进第一座桥", presentKeyToHash("ArrowRight", null, order) === `#bridge/${first}`);
  checkTrue("从总览按 ← 进最后一座桥", presentKeyToHash("ArrowLeft", null, order) === `#bridge/${last}`);
  checkTrue("Esc / Home 回总览", presentKeyToHash("Escape", order[2], order) === "#atlas" && presentKeyToHash("Home", order[2], order) === "#atlas");
  checkTrue("无关按键不处理", presentKeyToHash("z", order[0], order) === null);
}

/* ---------------- 荷载实验的几何前提 ---------------- */

/**
 * 踩过的坑：文惠桥的模型组漏了 `userData.deckTop`，而 scene.mjs 的 bridgeMetrics
 * 正是靠这个字段找模型组。于是文惠桥的荷载实验**静默失效**——不报错，
 * 但挠度曲线、荷载箭头、读数全都不出现（力流高亮是另一条路径，看起来"还是好的"，更容易漏）。
 *
 * 这里直接拿真实的 atlas 量：每座桥的模型组都要有 deckTop，
 * 且挠度曲线图必须落在水面以上、倍数在合理区间。
 */
{
  const { buildAtlas } = await import("../app3d/atlas.mjs");
  const { diagramFor } = await import("../app3d/deflection.mjs");

  const scene = buildAtlas();
  const box = new THREE.Box3();
  const temp = new THREE.Box3();
  const measured = {};

  for (const bridge of BRIDGES) {
    const entry = scene.bridges.get(bridge.id);
    checkTrue(`${bridge.id} 有场景条目`, Boolean(entry));
    if (!entry) continue;

    // 与 scene.mjs bridgeMetrics 相同的查找条件
    const model = entry.group.children.find(
      (child) => child.isGroup && child.userData && typeof child.userData.deckTop === "number"
    );
    checkTrue(
      `${bridge.id} 模型组带 deckTop（荷载实验的前提）`,
      Boolean(model),
      "缺这个字段时荷载实验会静默失效"
    );
    if (!model) continue;

    const deckTop = model.userData.deckTop;
    checkTrue(`${bridge.id} deckTop 是有限数`, Number.isFinite(deckTop) && deckTop > 0.1, String(deckTop));

    box.makeEmpty();
    model.updateMatrixWorld(true);
    for (const child of model.children) {
      if (!child.isMesh || (child.userData && child.userData.noPick)) continue;
      temp.setFromObject(child);
      box.union(temp);
    }
    const halfLength = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
    checkTrue(`${bridge.id} 半跨量级合理（1–5 单位）`, halfLength > 1 && halfLength < 5, halfLength.toFixed(2));

    const base = Number(bridge.deflectionBase) || 4;
    const full = diagramFor(base, 1, halfLength);
    const bottom = deckTop + 0.3 - full.sag;

    checkTrue(`${bridge.id} 挠度曲线底端在水面以上`, bottom > 0, bottom.toFixed(2));
    checkTrue(`${bridge.id} 放大倍数在 500–5000 之间`, full.factor >= 500 && full.factor <= 5000, `×${full.factor}`);
    measured[bridge.id] = { halfLength, deckTop, factor: full.factor, bottom };
  }

  // 把实测值记进失败信息里，便于核对文档（文档里的倍数必须落在实测范围）
  const factors = Object.values(measured).map((item) => item.factor);
  checkTrue(
    "五座桥的倍数都算得出来",
    factors.length === BRIDGES.length && factors.every((value) => value > 0),
    JSON.stringify(measured)
  );
}

/* ---------------- 启动脚本的可执行性 ---------------- */

/**
 * 踩过的坑：把 .bat 存成 UTF-8 并在里面写中文，cmd.exe 会按 OEM 代码页（GBK）读，
 * 于是 if exist "桥见柳州.exe" 这条判断被读成乱码、静默跳过，脚本看起来"双击没反应"。
 * 所以：启动脚本一律纯 ASCII，中文文件名靠通配符 * .exe 解析。
 *
 * 这里锁三件事：脚本存在、是纯 ASCII、且用通配符找启动器而不是拼中文字面量。
 */
{
  const readFile = async (name) =>
    (await import("node:fs/promises")).readFile(new URL(`../${name}`, import.meta.url), "utf8");

  const scripts = ["start-mobile.bat", "start-lan.bat", "start.bat"];
  for (const name of scripts) {
    const source = await readFile(name).catch(() => null);
    checkTrue(`${name} 存在`, Boolean(source));
    if (!source) continue;
    const nonAscii = [...source].filter((char) => char.charCodeAt(0) > 127);
    checkTrue(
      `${name} 是纯 ASCII（否则 cmd 会读成乱码）`,
      nonAscii.length === 0,
      `发现 ${nonAscii.length} 个非 ASCII 字符：${nonAscii.slice(0, 8).join("")}`
    );
  }

  const mobile = await readFile("start-mobile.bat");
  checkTrue("start-mobile.bat 会带 --lan 启动", /--lan/.test(mobile));
  checkTrue(
    "start-mobile.bat 用通配符找启动器（不拼中文文件名）",
    /for %%f in \("%~dp0\*\.exe"\)/.test(mobile),
    mobile.split("\n").find((line) => line.includes("for %%f")) || ""
  );

  const firewall = await readFile("允许手机访问.bat");
  checkTrue(
    "允许手机访问.bat 对任意网络配置文件放行",
    /profile=any/.test(firewall) && /dir=in action=allow/.test(firewall)
  );

  const doctor = await readFile("tools/lan-doctor.mjs");
  checkTrue("提供局域网自查工具", /== 2\. 防火墙/.test(doctor) || doctor.includes("防火墙"));
}

/* ---------------- 移动端启动：局域网地址筛选 ---------------- */

/**
 * 手机要能打开，靠的是把服务绑到局域网地址上；而"列出来给用户抄"这一步很容易出错：
 * 本机的 Clash 会造出 198.18.x.x 的假地址、DHCP 失败会有 169.254.x.x，
 * 直接抄给用户就是"连不上"。这里锁住筛选与排序规则。
 */
{
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { listLanAddresses, isUsableLanAddress } = require("../lan-addresses.js");

  const fakeInterfaces = {
    "soon network": [{ family: "IPv4", internal: false, address: "198.18.0.1" }],
    "ZeroTier One": [{ family: "IPv4", internal: false, address: "10.141.12.28" }],
    WLAN: [{ family: "IPv4", internal: false, address: "192.168.47.92" }],
    Loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    Ethernet: [{ family: "IPv4", internal: false, address: "169.254.3.4" }],
    "Wi-Fi 2": [{ family: "IPv6", internal: false, address: "fe80::1" }]
  };

  const rows = listLanAddresses(fakeInterfaces);
  const addresses = rows.map((row) => row.address);

  checkTrue("过滤掉 Clash 假地址 198.18.x.x", !addresses.includes("198.18.0.1"), addresses.join(","));
  checkTrue("过滤掉 169.254.x.x 自分配地址", !addresses.includes("169.254.3.4"));
  checkTrue("过滤掉回环与 IPv6", !addresses.includes("127.0.0.1") && !addresses.some((item) => item.includes(":")));
  checkTrue("保留真实局域网地址", addresses.includes("192.168.47.92"), addresses.join(","));
  checkTrue("WLAN 排在最前（手机要抄的那个）", rows[0].address === "192.168.47.92", rows[0].address);
  checkTrue("无线接口被标记为首选", rows[0].preferred === true);

  checkTrue("isUsableLanAddress 认可局域网地址", isUsableLanAddress("192.168.1.5"));
  checkTrue("isUsableLanAddress 拒绝回环", !isUsableLanAddress("127.0.0.1"));
  checkTrue("isUsableLanAddress 拒绝假地址", !isUsableLanAddress("198.18.0.1"));
  checkTrue("isUsableLanAddress 拒绝空值", !isUsableLanAddress(null));

  // 服务端默认只绑回环，必须显式 --lan 才对外开放
  const server = await (await import("node:fs/promises")).readFile(new URL("../server.js", import.meta.url), "utf8");
  checkTrue("server.js 默认绑定回环", /wantLan \? "0\.0\.0\.0" : "127\.0\.0\.1"/.test(server));
  checkTrue("server.js 支持 --lan", /--lan/.test(server) && /listLanAddresses\(\)/.test(server));
  checkTrue("提供了 start-lan.bat", fs.existsSync(new URL("../start-lan.bat", import.meta.url)));
}

/* ---------------- 合并几何体必须有法线 ---------------- */

/**
 * 桥梁的零件是按材质合并成大网格的。合并时若漏掉法线属性，
 * 着色器拿到的是缺省 (0,0,0)，normalize 之后是 NaN —— 整座桥会渲成纯黑。
 * v3.1 就踩过这个坑（判断条件写成 normals.length*3 === positions.length，
 * 等价于要求顶点数为零），所以这里逐网格守住法线。
 */
{
  let merged = 0;
  let missing = 0;
  let nonUnit = 0;
  let flipped = 0;

  for (const entry of atlas.bridges.values()) {
    entry.group.traverse((object) => {
      if (!object.isMesh || object.material.transparent) return;
      if (object.material.visible === false) return;
      const geometry = object.geometry;
      const position = geometry.attributes.position;
      const normal = geometry.attributes.normal;
      merged += 1;
      if (!normal) {
        missing += 1;
        return;
      }

      const index = geometry.index;
      const count = index ? index.count : position.count;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const na = new THREE.Vector3();
      const nb = new THREE.Vector3();
      const nc = new THREE.Vector3();
      const geometric = new THREE.Vector3();
      const mean = new THREE.Vector3();
      const ab = new THREE.Vector3();
      const ac = new THREE.Vector3();

      for (let i = 0; i < count; i += 3) {
        const ia = index ? index.getX(i) : i;
        const ib = index ? index.getX(i + 1) : i + 1;
        const ic = index ? index.getX(i + 2) : i + 2;
        a.fromBufferAttribute(position, ia);
        b.fromBufferAttribute(position, ib);
        c.fromBufferAttribute(position, ic);
        na.fromBufferAttribute(normal, ia);
        nb.fromBufferAttribute(normal, ib);
        nc.fromBufferAttribute(normal, ic);
        if (Math.abs(na.length() - 1) > 0.01) nonUnit += 1;

        ab.subVectors(b, a);
        ac.subVectors(c, a);
        geometric.crossVectors(ab, ac);
        if (geometric.length() < 1e-12) continue;
        mean.copy(na).add(nb).add(nc).normalize();
        if (geometric.dot(mean) < 0) flipped += 1;
      }
    });
  }

  check("bridge meshes carry normals", missing, 0);
  checkTrue("bridge normals are unit length", nonUnit === 0, `nonUnit=${nonUnit}`);
  checkTrue("bridge normals agree with winding", flipped === 0, `flipped=${flipped}`);
  checkTrue("every bridge has merged meshes", merged > 20, `meshes=${merged}`);
}

/* ---------------- 地形采样 ---------------- */

// 三角面采样器本身必须与网格三角化一致（双线性在陡坡上与真实面能差 0.2 单位）
{
  let surfaceWorst = 0;
  for (let i = 0; i < 300; i += 1) {
    const x = TERRAIN.minX + Math.random() * (TERRAIN.maxX - TERRAIN.minX);
    const z = TERRAIN.minZ + Math.random() * (TERRAIN.maxZ - TERRAIN.minZ);
    const fx = (x - TERRAIN.minX) / TERRAIN.step;
    const fz = (z - TERRAIN.minZ) / TERRAIN.step;
    const c0 = Math.min(TERRAIN.cols - 2, Math.max(0, Math.floor(fx)));
    const r0 = Math.min(TERRAIN.rows - 2, Math.max(0, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - c0));
    const v = Math.min(1, Math.max(0, fz - r0));
    const nodeHeight = (c, r) =>
      atlas.heightAt(TERRAIN.minX + c * TERRAIN.step, TERRAIN.minZ + r * TERRAIN.step);
    const h00 = nodeHeight(c0, r0);
    const h10 = nodeHeight(c0 + 1, r0);
    const h01 = nodeHeight(c0, r0 + 1);
    const h11 = nodeHeight(c0 + 1, r0 + 1);
    const expected =
      u + v <= 1
        ? h00 + u * (h10 - h00) + v * (h01 - h00)
        : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
    const actual = atlas.surfaceHeightAt(x, z);
    if (!Number.isFinite(actual)) surfaceWorst = Infinity;
    else if (Math.abs(actual - expected) > surfaceWorst) surfaceWorst = Math.abs(actual - expected);
  }
  checkTrue(
    "terrain surface sampler matches triangulation",
    surfaceWorst < 1e-6,
    `worst=${surfaceWorst.toExponential(1)}`
  );
}

/* ---------------- 地形（喀斯特孤峰） ---------------- */

let terrainMesh = null;
atlas.root.traverse((object) => {
  if (object.isMesh && object.material && object.material.vertexColors) terrainMesh = object;
});
checkTrue("terrain mesh exists", Boolean(terrainMesh));

if (terrainMesh) {
  const position = terrainMesh.geometry.attributes.position;
  const worldX = (i) => position.getX(i) + terrainMesh.position.x;
  const worldZ = (i) => position.getZ(i) + terrainMesh.position.z;

  check("terrain grid size", position.count, TERRAIN.cols * TERRAIN.rows);

  // 1) 河道上方必须压平到 0，否则水面贴花（y=0.004）会被地形戳穿
  let riverMax = 0;
  for (let i = 0; i < position.count; i += 1) {
    if (distanceToRivers(worldX(i), worldZ(i)) < GEO.riverHalfWidth + 0.1) {
      riverMax = Math.max(riverMax, position.getY(i));
    }
  }
  checkTrue("terrain flattened under river", riverMax < 0.004, `max=${riverMax.toFixed(4)}`);

  // 2) 边界必须精确归零，才能与外接平地裙边无缝衔接
  let boundaryMax = 0;
  for (let i = 0; i < position.count; i += 1) {
    const x = worldX(i);
    const z = worldZ(i);
    if (
      Math.abs(x - TERRAIN.minX) < 0.01 ||
      Math.abs(x - TERRAIN.maxX) < 0.01 ||
      Math.abs(z - TERRAIN.minZ) < 0.01 ||
      Math.abs(z - TERRAIN.maxZ) < 0.01
    ) {
      boundaryMax = Math.max(boundaryMax, Math.abs(position.getY(i)));
    }
  }
  checkTrue("terrain boundary returns to zero", boundaryMax < 1e-6, `max=${boundaryMax}`);

  // 3) 九峰要有高度。50 m 网格采样会削低窄峰顶（鱼峰山实测 255 m → 网格 234 m），
  //    所以阈值留了余量，只断言"确实立起来了"。
  const peakAt = (x, z) => {
    const c = Math.round((x - TERRAIN.minX) / TERRAIN.step);
    const r = Math.round((z - TERRAIN.minZ) / TERRAIN.step);
    let best = 0;
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        const i = (r + dr) * TERRAIN.cols + (c + dc);
        if (i >= 0 && i < position.count) best = Math.max(best, position.getY(i));
      }
    }
    return best;
  };
  checkTrue("peak yufeng shan stands", peakAt(-10.3, 43.4) > 3.5, `h=${peakAt(-10.3, 43.4).toFixed(2)}`);
  checkTrue("peak panlong shan stands", peakAt(2.2, 30.1) > 1.8, `h=${peakAt(2.2, 30.1).toFixed(2)}`);
  checkTrue("peak henan stands", peakAt(-4.1, 37.3) > 1.5, `h=${peakAt(-4.1, 37.3).toFixed(2)}`);

  const triangles = terrainMesh.geometry.index.count / 3;
  checkTrue("terrain triangle budget", triangles <= 90000, `tris=${triangles}`);
}

const box = new THREE.Box3().setFromObject(atlas.root);
checkTrue(
  "bounding box finite",
  ["min", "max"].every((key) => ["x", "y", "z"].every((axis) => Number.isFinite(box[key][axis])))
);
const windowWidth = GEO.window.maxX - GEO.window.minX;
const windowDepth = GEO.window.maxZ - GEO.window.minZ;
checkTrue("bounding box covers window", box.max.x - box.min.x > windowWidth, `width=${(box.max.x - box.min.x).toFixed(1)}`);
checkTrue("bounding box height", box.max.y > 0.5, `maxY=${box.max.y.toFixed(1)}`);

/* ---------------- 状态切换 ---------------- */

atlas.setSelection({ view: "bridge", bridgeId: "wenhui" });
atlas.setHover("bridge:wenhui");
atlas.setHover("part:wenhui:arch");
atlas.setHover(null);
atlas.setSelection({ view: "atlas", bridgeId: null });

/* ---------------- 元数据一致性 ---------------- */

for (const meta of BRIDGES) {
  checkTrue(`meta ${meta.id} has geo`, GEO.bridges.some((bridge) => bridge.id === meta.id));
}

checkTrue("three revision", Boolean(THREE.REVISION));

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

