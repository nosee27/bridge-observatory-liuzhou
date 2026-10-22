/**
 * 场景状态机 + hash 路由 + 浏览器前进/后退。
 *
 * 地址约定（三个视图）：
 *   #atlas                       城市总览
 *   #bridge/<id>                 单桥视图；查询参数都是"可选装置"：
 *                                  exp=1      打开实验词条（左栏）
 *                                  step=<n>   力流第 n 步（0 起）
 *                                  load=<0-1> 车辆荷载
 *                                  colors=1   受力配色
 *                                  explode=1  结构拆解
 *                                  quiz=<n>   资料词条滚到第 n 题
 *   #browse                      列表视图（降级 / 无障碍）
 *
 * 变化史：早先有 #lab / #archive 两个"建筑视图"（结构实验室、档案馆）。
 * 2026-10-22 起按要求砍掉两栋建筑，实验与档案都并进单桥视图；
 * 旧链接（#lab、#archive、更早的 #bridge=x&mode=...）一律平滑回落，不留白屏。
 */

import { BRIDGE_IDS } from "./data.mjs";

export const VIEWS = ["atlas", "bridge", "browse"];

/** 已退役的"建筑视图"：没有实体建筑了，落到总览。 */
const RETIRED_VIEWS = ["lab", "archive"];

function parseIndex(value) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseRatio(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(1, Math.max(0, parsed));
}

const EMPTY = {
  view: "atlas",
  bridgeId: null,
  exp: false,
  step: null,
  load: null,
  colors: false,
  exploded: false,
  quiz: null,
  legacy: false
};

/** 是否为旧版 `#bridge=wenhui&mode=force` 形式的链接。 */
export function isLegacyHash(hash = window.location.hash) {
  const raw = String(hash).replace(/^#/, "").trim();
  // 新格式带路径分隔符（#bridge/wenhui?exp=1），即使含 "=" 也不是旧格式。
  if (!raw || raw.includes("/")) return false;
  return /^[A-Za-z][A-Za-z0-9_]*=/.test(raw);
}

/**
 * 解析 hash 为状态对象。
 * 无法识别的地址一律回落到 atlas，保证不会出现空白场景。
 */
export function parseHash(hash = window.location.hash) {
  const raw = String(hash).replace(/^#/, "").trim();
  if (!raw) return { ...EMPTY };

  // 旧链接：bridge=wenhui&mode=force&explode=1
  if (isLegacyHash(raw)) {
    const params = new URLSearchParams(raw);
    const bridgeId = params.get("bridge");
    const known = BRIDGE_IDS.includes(bridgeId);
    return {
      ...EMPTY,
      view: known ? "bridge" : "atlas",
      bridgeId: known ? bridgeId : null,
      exploded: params.get("explode") === "1",
      step: parseIndex(params.get("step")),
      legacy: true
    };
  }

  const hashIndex = raw.indexOf("?");
  const pathPart = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const queryPart = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";
  const params = new URLSearchParams(queryPart);
  const segments = pathPart.split("/").filter(Boolean);
  const head = segments[0] || "atlas";

  if (head === "bridge") {
    const bridgeId = segments[1] || null;
    if (!BRIDGE_IDS.includes(bridgeId)) return { ...EMPTY };
    return {
      ...EMPTY,
      view: "bridge",
      bridgeId,
      exp: params.get("exp") === "1",
      step: parseIndex(params.get("step")),
      load: parseRatio(params.get("load")),
      colors: params.get("colors") === "1",
      exploded: params.get("explode") === "1",
      quiz: parseIndex(params.get("quiz"))
    };
  }

  // 已退役的建筑视图：给一条能用的落地地址
  if (RETIRED_VIEWS.includes(head)) return { ...EMPTY };

  if (head === "browse") return { ...EMPTY, view: "browse" };

  return { ...EMPTY };
}

/** 状态对象 → hash 字符串。 */
export function toHash(state) {
  const view = VIEWS.includes(state.view) ? state.view : "atlas";

  if (view === "bridge" && state.bridgeId && BRIDGE_IDS.includes(state.bridgeId)) {
    const params = new URLSearchParams();
    if (state.exp) params.set("exp", "1");
    if (Number.isInteger(state.step) && state.step >= 0) params.set("step", String(state.step));
    if (typeof state.load === "number" && state.load > 0) {
      params.set("load", String(Math.round(state.load * 100) / 100));
    }
    if (state.colors) params.set("colors", "1");
    if (state.exploded) params.set("explode", "1");
    if (Number.isInteger(state.quiz) && state.quiz >= 0) params.set("quiz", String(state.quiz));
    const query = params.toString();
    return `#bridge/${state.bridgeId}${query ? `?${query}` : ""}`;
  }

  return `#${view === "bridge" ? "atlas" : view}`;
}

export function sameState(a, b) {
  if (!a || !b) return false;
  return (
    a.view === b.view &&
    a.bridgeId === b.bridgeId &&
    Boolean(a.exp) === Boolean(b.exp) &&
    (a.step ?? null) === (b.step ?? null) &&
    (a.load ?? null) === (b.load ?? null) &&
    Boolean(a.colors) === Boolean(b.colors) &&
    Boolean(a.exploded) === Boolean(b.exploded) &&
    (a.quiz ?? null) === (b.quiz ?? null)
  );
}

/**
 * 创建路由。
 * @param {(state: object, meta: { initial: boolean }) => void} onChange
 */
export function createRouter(onChange) {
  let current = null;

  function emit() {
    const next = parseHash(window.location.hash);
    if (current && sameState(current, next)) return;
    current = next;
    onChange(next, { initial: false });
  }

  function start() {
    const next = parseHash(window.location.hash);
    current = next;
    onChange(next, { initial: true });
  }

  /** 只改写地址栏，不触发 onChange（不产生 hashchange）。 */
  function replace(state) {
    current = state;
    try {
      window.history.replaceState(null, "", toHash(state));
    } catch {
      // 浏览器限制 history 时，地址栏保留旧值也不影响功能。
    }
  }

  window.addEventListener("hashchange", emit);
  window.addEventListener("popstate", emit);

  return {
    start,
    replace,
    emit,
    get current() {
      return current;
    }
  };
}
