/**
 * 构件受力性质（受拉 / 受压 / 受弯 / 传递荷载）。
 *
 * 来源：app.js 的 comparisonProfiles[].force 文字 + 各桥的真实结构形式。
 * 这张表只用于"教学配色"，不是有限元结果——颜色表示该构件**主要**受力性质，
 * 真实结构里构件往往同时受弯、剪、压。
 *
 * 键是 bridge.model（与 app.js 的 model 字段一致），值把 part id 映射到性质：
 *   tension      受拉（斜拉索、吊杆、拱的系杆）
 *   compression  受压（拱肋、桥墩、主塔、基础、支座）
 *   bending      受弯（主梁、箱梁）
 *   load         直接承接荷载（桥面）
 *   transfer     传力但性质混合（锚固区、桥台、连廊）
 */

export const FORCE_NATURES = ["load", "bending", "tension", "compression", "transfer"];

/** 每种性质在图例里的说明。 */
export const FORCE_LEGEND = {
  load: { label: "承接荷载", hint: "车辆与行人直接压在它上面" },
  bending: { label: "受弯", hint: "中间下沉、两端上翘，把竖荷载转成弯矩" },
  tension: { label: "受拉", hint: "被拉长的那一侧，力沿着构件往外拉" },
  compression: { label: "受压", hint: "被压紧，力沿着构件往下传" },
  transfer: { label: "传力过渡", hint: "把力在两种构件之间转换、分散" }
};

export const FORCE_BY_MODEL = {
  girder: {
    deck: "load",
    girder: "bending",
    pier: "compression",
    foundation: "compression"
  },
  arch: {
    deck: "load",
    hanger: "tension",
    arch: "compression",
    abutment: "compression"
  },
  continuous: {
    deck: "load",
    "box-girder": "bending",
    pier: "compression",
    bearing: "compression"
  },
  cable: {
    deck: "load",
    cable: "tension",
    ring: "compression",
    anchor: "transfer",
    support: "compression"
  },
  pavilion: {
    deck: "load",
    pavilion: "transfer",
    gallery: "transfer",
    pier: "compression"
  }
};

/** 取某座桥每种构件的受力性质；未知构件返回 null。 */
export function natureOf(model, partId) {
  const table = FORCE_BY_MODEL[model];
  if (!table) return null;
  return table[partId] || null;
}

/** 把一座桥的构件整理成 [{ partId, nature }]，顺序稳定（按表里的键序）。 */
export function forceEntries(model, availablePartIds = null) {
  const table = FORCE_BY_MODEL[model];
  if (!table) return [];
  const allowed = availablePartIds ? new Set(availablePartIds) : null;
  return Object.entries(table)
    .filter(([partId]) => !allowed || allowed.has(partId))
    .map(([partId, nature]) => ({ partId, nature }));
}
