/**
 * 两种交付形态：投屏排版（?present=1）与自助体验（?kiosk=1）。
 *
 * 投屏：放大字号与按钮、提高对比度，键盘 ←/→ 或数字 1–5 快速切桥。
 * 自助：定时自动巡览（总览 → 五座桥），观众一旦操作即暂停接管，
 *       长时间无操作则复位回总览并继续巡览。
 *
 * 这里只放"可测试的纯逻辑"，DOM 接线在 main.mjs。
 */

/** 巡览站点：先看城市总览，再逐桥推进。 */
export const KIOSK_STOPS = [
  "#atlas",
  "#bridge/liujiang",
  "#bridge/wenhui",
  "#bridge/wenchang",
  "#bridge/baisha",
  "#bridge/fenghuangling"
];

/** 每站停留时间（毫秒）。5 秒看清总览、9 秒看清一座桥。 */
export const KIOSK_DWELL_MS = 9000;

/** 观众停止操作多久后恢复巡览（毫秒）。 */
export const KIOSK_IDLE_RESUME_MS = 45000;

/** 从查询串里读形态开关。支持 ?present=1 与 ?kiosk=1。 */
export function readFlags(search = "") {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  // 注意：参数**不存在**时 get() 返回 null，不能当成"开了"——
  // 早先 truthy("") 返回 true，导致不带参数的普通打开也会进入投屏+自助。
  const truthy = (value) => value === "1" || value === "true";
  return {
    present: truthy(params.get("present")),
    kiosk: truthy(params.get("kiosk"))
  };
}

/** 巡览的下一站（循环）。 */
export function nextStop(index) {
  const safe = Number.isInteger(index) ? index : 0;
  return KIOSK_STOPS[(safe + 1) % KIOSK_STOPS.length];
}

/** 数字键 → 桥 id（投屏模式下 1–5 直接跳桥）。 */
export const BRIDGE_HOTKEYS = {
  1: "liujiang",
  2: "wenhui",
  3: "wenchang",
  4: "baisha",
  5: "fenghuangling"
};

/**
 * 投屏模式的键盘映射。返回要跳的 hash，或 null 表示不处理。
 * ←/→ 在桥与桥之间移动；Home/Esc 回总览。
 */
export function presentKeyToHash(key, currentBridgeId = null, bridgeOrder = []) {
  const order = bridgeOrder.length > 0 ? bridgeOrder : Object.values(BRIDGE_HOTKEYS);
  const digits = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4 };
  if (key in digits && order[digits[key]]) return `#bridge/${order[digits[key]]}`;
  if (key === "Home" || key === "Escape") return "#atlas";

  const index = currentBridgeId ? order.indexOf(currentBridgeId) : -1;
  if (key === "ArrowRight" || key === "ArrowDown" || key === "n" || key === "N") {
    const nextIndex = index < 0 ? 0 : Math.min(order.length - 1, index + 1);
    return `#bridge/${order[nextIndex]}`;
  }
  if (key === "ArrowLeft" || key === "ArrowUp" || key === "p" || key === "P") {
    if (index < 0) return `#bridge/${order[order.length - 1]}`;
    return `#bridge/${order[Math.max(0, index - 1)]}`;
  }
  return null;
}
