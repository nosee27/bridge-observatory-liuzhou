/**
 * 挠度演示的换算（纯函数，方便在 Node 里直接断言）。
 *
 * 这里有个物理上绕不开的矛盾：
 *   - 真实跨中下沉只有"几厘米"。在 1:100 的模型里是 0.000x 世界单位，
 *     而实验视角（距离 7.5、fov 45°）的视野高度约 6.2 单位——下沉只占屏高 1–2%，
 *     换算到 800px 的窗口只有 6–15 像素，根本看不出来。
 *   - 直接把桥面压下去也不行：桥面离水面只有 0.24–0.43 单位，
 *     放大到看得见的幅度，跨中就会沉到水面以下，看起来像"桥塌了"。
 *
 * 所以 3D 里的挠度**不画在桥面上**，而是画成桥面上方的一幅"挠度曲线图"（工程插图的做法）：
 * 基线与桥面平行，曲线按半跨的固定比例下沉，幅度不受桥面高度限制。
 * 放大倍数按每座桥的真实挠度现算，四舍五入到两位有效数字后写进标签，
 * 保证标签上的数字与实际画出来的幅度严格一致。
 */

/** 曲线摆幅占半跨的比例（满荷载时）。0.18 在半跨 1.7–3.4 的桥上约 0.3–0.6 单位，占屏高 5%–10%，
 * 同时保证曲线底端仍在水面以上；再大就会沉进水里。 */
export const DIAGRAM_RATIO = 0.18;

/** 满荷载时，真实下沉 ≈ deflectionBase × 0.5 厘米（教学取值的量级）。 */
export const CM_PER_DEFLECTION_UNIT = 0.5;

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));

/** 真实下沉（厘米）。 */
export function deflectionCm(deflectionBase, load) {
  return Math.max(0, Number(deflectionBase) || 0) * CM_PER_DEFLECTION_UNIT * clamp01(load);
}

/** 真实下沉换算成世界单位：厘米 → 米（/100）→ 单位（1 单位 = 100 m，再 /100）。 */
export function realSagUnits(deflectionBase, load) {
  return deflectionCm(deflectionBase, load) / 10000;
}

/** 四舍五入到两位有效数字：1034 → 1000，258 → 260。 */
export function niceFactor(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.max(1, Math.round(value / magnitude) * magnitude);
}

/**
 * 挠度曲线图的参数。
 * @returns {{realCm: number, factor: number, sag: number}}
 *   realCm 真实下沉（厘米）；factor 放大倍数（两位有效数字）；sag 曲线摆幅（世界单位）
 */
export function diagramFor(deflectionBase, load, halfLength) {
  const clamped = clamp01(load);
  const realCm = deflectionCm(deflectionBase, clamped);
  const realUnits = realCm / 10000;
  if (realUnits <= 0) return { realCm: 0, factor: 0, sag: 0 };

  const span = Math.max(0.6, Number(halfLength) || 1);
  const target = span * DIAGRAM_RATIO * clamped;
  const factor = niceFactor(target / realUnits);
  return { realCm, factor, sag: realUnits * factor };
}

/** 标签文字："挠度曲线 ×1000"。 */
export function labelFor(factor) {
  return `挠度曲线 ×${factor}`;
}
