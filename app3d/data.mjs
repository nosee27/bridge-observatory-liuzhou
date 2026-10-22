/**
 * 3D 场景的桥梁数据入口。
 *
 * 唯一权威来源是 app.js 里的几个顶层字面量（2D 页面在用它），
 * 由 tools/build-bridge-data.mjs 抽成 ES 模块 app3d/bridges.data.mjs，
 * 这里只做再导出 + 场景需要的派生量。改动数据请改 app.js 后重跑生成脚本。
 */

import {
  BRIDGES,
  BRIDGE_BY_ID,
  PROFILES,
  GOALS,
  SOURCES,
  SOURCE_LIBRARY,
  QUIZ
} from "./bridges.data.mjs";

export { BRIDGES, BRIDGE_BY_ID, PROFILES, GOALS, SOURCES, SOURCE_LIBRARY, QUIZ };

export const BRIDGE_IDS = BRIDGES.map((bridge) => bridge.id);

/** 总览平面上桥梁坐标的映射范围（世界单位）。 */
export const ATLAS_SPAN = { width: 46, depth: 30 };

/** 柳江河道相对正东方向的旋转角（弧度），由五座桥坐标的趋势拟合而来。 */
export const RIVER_ANGLE = 0.487;
