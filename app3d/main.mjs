/**
 * M0 外壳入口：能力检测 → 路由 → 3D 场景 / 列表视图切换。
 *
 * 设计要点：
 *   - 3D 不可用（file:// 或 无 WebGL）时，整套 3D 不加载，直接进列表视图；
 *   - 现有 2D 页面（app.js）保持原样，列表视图就是它；
 *   - 列表视图中由 app.js 写入的旧格式 hash 与页内锚点，不会把用户拽进 3D。
 */

import {
  BRIDGES,
  BRIDGE_BY_ID,
  GOALS,
  PROFILES,
  QUIZ,
  SOURCES,
  SOURCE_LIBRARY
} from "./data.mjs";
import { diagramFor } from "./deflection.mjs";
import { FORCE_LEGEND } from "./force-map.mjs";
import { createLab } from "./lab.mjs";
import { createPanel } from "./panel.mjs";
import {
  BRIDGE_HOTKEYS,
  KIOSK_DWELL_MS,
  KIOSK_IDLE_RESUME_MS,
  KIOSK_STOPS,
  nextStop,
  presentKeyToHash,
  readFlags
} from "./show-mode.mjs";
import { createRouter, toHash } from "./state.mjs";

const els = {
  legacyRoot: document.getElementById("legacyRoot"),
  app3d: document.getElementById("app3d"),
  canvas: document.getElementById("sceneCanvas"),
  labels: document.getElementById("sceneLabels"),
  kicker: document.getElementById("sceneKicker"),
  title: document.getElementById("sceneTitle"),
  sub: document.getElementById("sceneSub"),
  status: document.getElementById("sceneStatus"),
  bridgeList: document.getElementById("sceneBridgeList"),
  panel: document.getElementById("scenePanel"),
  labPanel: document.getElementById("sceneLab"),
  btnExperiment: document.getElementById("btnExperiment"),
  btnBrowse: document.getElementById("btnBrowse"),
  btnReset: document.getElementById("btnResetView"),
  guide: document.getElementById("guideDialog"),
  bootNotice: document.getElementById("bootNotice"),
  bootTitle: document.getElementById("bootNoticeTitle"),
  bootBody: document.getElementById("bootNoticeBody"),
  bootBrowse: document.getElementById("bootNoticeBrowse")
};

const navItems = Array.from(document.querySelectorAll("[data-nav]"));

/**
 * WebGL 预检：只用来在 HUD 上显示状态，**不再决定首屏**。
 *
 * 分离的 canvas 上 getContext('webgl') 在个别环境会返回 null（假阴性），
 * 而真正挂到页面上的 canvas 能正常建上下文。早先正是拿这个预检当开关，
 * 于是在这类环境里"打开就是二维版"。现在一律先尝试建场景，
 * 只有真正抛异常才回退二维，并把原因显示出来。
 */
function detectWebGL() {
  try {
    const probe = document.createElement("canvas");
    return Boolean(
      probe.getContext("webgl2") ||
        probe.getContext("webgl") ||
        probe.getContext("experimental-webgl")
    );
  } catch {
    return false;
  }
}

const isFileProtocol = window.location.protocol === "file:";
const webglAvailable = detectWebGL();

// 只有 file:// 才在入口就拦下（ES 模块在 file:// 下根本加载不了）。
// WebGL 预检失败也照样进三维，让真实的初始化去判断。
let browseOnly = isFileProtocol;
let scene = null;
let sceneInitPromise = null;
let renderedView = null;
let latestState = null;
let returnButton = null;
let router = null;
let panel = null;
let lab = null;
/** 正在等待场景就绪的构件高亮（先跳视图、再高亮）。 */
let pendingPart = null;

/** 投屏 / 自助两种交付形态（由查询串决定，如 ?present=1）。 */
const showFlags = readFlags(window.location.search);
/** 自助巡览：当前站序号与定时器。 */
let kioskIndex = -1;
let kioskTimer = null;
let kioskResumeTimer = null;
let kioskSuspended = false;

/** 自动播放力流的定时器。 */
let labTimer = null;
/** 荷载读数文案（由场景回传）。 */
let labLoadText = "";
/** 曲线图的放大倍数说明（按桥现算，拿到第一帧读数后才有）。 */
let labBadgeLabel = "";
/** 荷载地址防抖定时器（拖滑杆时不反复写历史）。 */
let loadCommitTimer = null;

/**
 * 只改"同视图内的参数"（step / load / colors / explode / exp）。
 *
 * 关键：用 history.replaceState 而不是 location.hash。
 * 给 location.hash 赋值是一次**浏览器导航**，会触发 fragment 滚动定位——
 * 目标 id 不存在时浏览器会把滚动容器拉回顶部，于是拖载荷滑杆时词条会"跳回最上面"。
 * replaceState 只换地址、不导航、不滚动；重绘由这里自己调。
 */
function applyStateParams(patch) {
  const state = router ? router.current : null;
  if (!state) return;
  const next = { ...state, ...patch };
  router.replace(next);
  latestState = next;
  if (next.view === "browse") renderBrowse();
  else renderApp3d(next);
}

function stopLabPlayback() {
  if (labTimer !== null) {
    window.clearInterval(labTimer);
    labTimer = null;
  }
}

/**
 * 实验状态全部来自路由：exp / step / load / colors / explode 都在 hash 里。
 * 这样刷新、分享、前进后退都能回到同一次实验。
 */
function experimentState(state) {
  return {
    exp: Boolean(state.exp),
    step: Number.isInteger(state.step) ? state.step : null,
    load: typeof state.load === "number" ? state.load : 0,
    colors: Boolean(state.colors),
    exploded: Boolean(state.exploded)
  };
}

/** 力流步骤表：场景就绪后从 scene 取（FORCE_FLOW 在 scene.mjs 里）。 */
function labFlow(bridgeId) {
  if (!scene || !scene.forceFlow) return [];
  return scene.forceFlow(bridgeId) || [];
}

/**
 * 从 3D 资料卡跳到 2D 的"结构实验室"章节。
 * 先切到列表视图（3D 外壳隐藏、legacy 页面显示），再滚到 #lab——
 * 不能直接把 hash 设成 #lab：那会被 3D 路由当成"3D 实验室"接走。
 */
function openLegacyLab() {
  window.location.hash = "#browse";
  window.setTimeout(() => {
    const section = document.getElementById("lab");
    if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 160);
}

/** 浏览模式下只认这三种地址，其余（页内锚点、旧格式）交给 2D 页面。 */
function isSceneRoute(hash) {
  const raw = String(hash).replace(/^#/, "");
  if (raw === "atlas" || raw === "browse") return true;
  return /^bridge\/[A-Za-z0-9_-]+/.test(raw);
}

function closeGuide() {
  const dialog = els.guide;
  if (dialog && dialog.open) {
    try {
      dialog.close();
    } catch {
      /* 忽略：关闭失败不影响主流程 */
    }
  }
}

/**
 * app.js 首次访问会在 650ms 后自动 showModal 弹出新手引导。
 * 该引导讲的是 2D 流程，在 3D 场景里既不合语境，模态框还会让页面 inert。
 * 这里在 3D 视图下拦截它：优先用 dialog 的 toggle 事件（无闪烁），
 * 再用几个定时器兜底不支持该事件的浏览器。列表视图下不干预。
 */
function guardGuideIn3d() {
  const dialog = els.guide;
  if (!dialog) return;
  // 自助/投屏形态下不要新手引导挡住画面
  if (showFlags.kiosk || showFlags.present) {
    closeGuide();
    return;
  }

  const enforce = () => {
    if (renderedView && renderedView !== "browse" && dialog.open) {
      closeGuide();
    }
  };

  if (typeof dialog.addEventListener === "function") {
    dialog.addEventListener("toggle", enforce);
  }
  for (const delay of [700, 1200, 2500]) {
    window.setTimeout(enforce, delay);
  }
}

function describe(state) {
  if (state.view === "bridge") {
    const bridge = BRIDGE_BY_ID.get(state.bridgeId);
    if (bridge) {
      const profile = PROFILES[bridge.model];
      const flow = labFlow(state.bridgeId);
      const stepText =
        Number.isInteger(state.step) && state.step >= 0 && flow[state.step]
          ? `第 ${state.step + 1} 步 · ${flow[state.step]}`
          : "选一步开始";

      // 实验词条打开时，标题行顺带交代当前实验状态；收起时回到普通桥名
      let sub = `${bridge.year} 年 · ${bridge.type} · 点桥上的构件看它的作用，右侧资料词条会跟着定位。`;
      if (state.exp) {
        sub = `${stepText}。${profile ? profile.force : ""}`;
        if (typeof state.load === "number" && state.load > 0) {
          sub += ` 荷载 ${Math.round(state.load * 100)}%。`;
        }
        if (state.exploded) sub += " 已拆解。";
      }
      return {
        kicker: `M2 / BRIDGE · ${bridge.order}`,
        title: bridge.name,
        sub
      };
    }
  }
  return {
    kicker: "M2 / CITY ATLAS",
    title: "柳江 · LIUJIANG",
    sub: "真实河道与五桥位置（OpenStreetMap）。拖动可任意角度环视，滚轮以光标为中心缩放；点桥梁进入资料词条，点构件看它在受力里干什么。"
  };
}

function updateStatus(state) {
  if (!els.status) return;
  const parts = [toHash(state)];
  if (isFileProtocol) parts.push("file://");
  else if (!webglAvailable) parts.push("WebGL 不可用");
  else parts.push("WebGL 就绪");
  if (scene) parts.push(`three r${scene.revision}`);
  parts.push("1 单位 = 100 m");
  els.status.textContent = parts.join(" · ");
}

function buildBridgeList() {
  if (!els.bridgeList) return;
  const fragment = document.createDocumentFragment();
  for (const bridge of BRIDGES) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "app3d-bridge-link";
    link.href = `#bridge/${bridge.id}`;
    link.dataset.bridge = bridge.id;
    link.style.setProperty("--dot", bridge.accent);

    const dot = document.createElement("i");
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = `${bridge.order} ${bridge.name}`;

    link.append(dot, label);
    item.append(link);
    fragment.append(item);
  }
  els.bridgeList.append(fragment);
}

function syncReturnButton(visible) {
  if (visible && !browseOnly) {
    if (!returnButton) {
      returnButton = document.createElement("a");
      returnButton.className = "return-3d";
      returnButton.href = "#atlas";
      returnButton.textContent = "← 返回 3D 城市总览";
    }
    if (!returnButton.isConnected) document.body.append(returnButton);
    return;
  }
  if (returnButton && returnButton.isConnected) returnButton.remove();
}

function showBootNotice(title, bodyHtml) {
  if (!els.bootNotice) return;
  if (els.bootTitle) els.bootTitle.textContent = title;
  if (els.bootBody) els.bootBody.innerHTML = bodyHtml;
  els.bootNotice.hidden = false;
}

function handlePick(pick) {
  if (!pick) return;

  // 构件：先确保进到这座桥的视图，再高亮并让资料卡滚到那一行
  if (pick.type === "part") {
    const state = router ? router.current : null;
    const alreadyHere = state && state.view === "bridge" && state.bridgeId === pick.id;
    if (alreadyHere) {
      focusPart(pick.id, pick.partId);
    } else {
      pendingPart = { bridgeId: pick.id, partId: pick.partId };
      window.location.hash = `#bridge/${pick.id}`;
    }
    return;
  }

  if (pick.type === "bridge") {
    window.location.hash = `#bridge/${pick.id}`;
  }
}

/** 高亮构件并把资料卡同步到那一行。 */
function focusPart(bridgeId, partId) {
  const hit = scene && scene.highlightPart ? scene.highlightPart(bridgeId, partId) : null;
  if (panel && panel.isOpen) panel.focusPart(partId);
  return hit;
}

function initScene() {
  if (sceneInitPromise) return sceneInitPromise;
  sceneInitPromise = (async () => {
    const module = await import("./scene.mjs");
    const instance = await module.createScene({
      canvas: els.canvas,
      labelLayer: els.labels,
      onPick: handlePick,
      // 受力演示每走一步，资料卡跟到那个构件
      onPartFocus: (bridgeId, partId) => {
        if (!panel) return;
        // 自动同步（力流步骤重放）不滚动词条：载荷滑杆每 tick 都会走到这里，
        // 带滚动的话用户刚滚到"答题"就会被拽回"构件"。
        if (partId) panel.focusPart(partId, { scroll: false });
        else if (bridgeId === null) panel.focusPart(null, { scroll: false });
      }
    });
    scene = instance;
    if (latestState) {
      applyPanel(latestState);
      applyExperiment(latestState);
    }
    return instance;
  })();
  return sceneInitPromise;
}

async function ensureSceneReady(state) {
  try {
    const instance = scene || (await initScene());
    if (latestState) instance.setState(latestState);
    instance.start();
    updateStatus(latestState || state);
  } catch (error) {
    console.error("[app3d] 场景初始化失败", error);
    browseOnly = true;
    showBootNotice(
      "3D 场景加载失败",
      `无法初始化 WebGL 场景（${String((error && error.message) || error)}）。已切换到二维版本，全部内容仍可访问。` +
        " 如果浏览器禁用了硬件加速，可在 Edge 设置里打开「使用图形加速」后重试。"
    );
    window.location.hash = "#browse";
  }
}

/**
 * 移动端抽屉拖手：向上拖/点一下 = 全屏，向下拖 = 半屏。
 * 桌面端不生效（面板本来就固定在侧边）。
 */
function bindSheet(host) {
  if (!host) return;
  const handle = host.querySelector(".a3d-sheet-handle");
  if (handle) return;

  const created = document.createElement("button");
  created.type = "button";
  created.className = "a3d-sheet-handle";
  created.setAttribute("aria-label", "拖动切换半屏或全屏");
  host.prepend(created);

  const isMobile = () => window.matchMedia("(max-width: 720px)").matches;
  let startY = null;

  created.addEventListener("pointerdown", (event) => {
    if (!isMobile()) return;
    startY = event.clientY;
    try {
      created.setPointerCapture(event.pointerId);
    } catch {
      /* 忽略：个别浏览器不支持捕获 */
    }
  });

  created.addEventListener("pointerup", (event) => {
    if (startY === null) return;
    const dy = event.clientY - startY;
    startY = null;
    const current = host.dataset.sheet === "full" ? "full" : "half";
    let next = current;
    if (Math.abs(dy) > 30) next = dy < 0 ? "full" : "half";
    else next = current === "full" ? "half" : "full";
    host.dataset.sheet = next;
  });

  if (isMobile()) host.dataset.sheet = host.dataset.sheet || "half";
}

/** 只有"单桥视图"才显示资料卡；其余视图收起并清掉构件高亮。 */
function applyPanel(state) {
  if (!panel) return;
  if (!state || state.view !== "bridge") {
    panel.hide();
    if (scene && scene.clearPartHighlight) scene.clearPartHighlight();
    return;
  }
  const bridge = BRIDGE_BY_ID.get(state.bridgeId);
  if (!bridge) {
    panel.hide();
    return;
  }
  const modeled = scene && scene.getPartIds ? scene.getPartIds(state.bridgeId) : [];
  panel.show(bridge, {
    modeled,
    profiles: PROFILES,
    goals: GOALS,
    sources: SOURCES,
    sourceLibrary: SOURCE_LIBRARY,
    quiz: QUIZ,
    bridges: BRIDGES
  });
  bindSheet(els.panel);
  document.body.classList.toggle("a3d-mobile-exp", Boolean(state.exp));

  if (pendingPart && pendingPart.bridgeId === state.bridgeId) {
    if (scene && scene.highlightPart) {
      const waiting = pendingPart.partId;
      pendingPart = null;
      focusPart(state.bridgeId, waiting);
    } else {
      // 场景尚未就绪：卡片先定位，待办保留——initScene 就绪后会再走一次 applyPanel
      panel.focusPart(pendingPart.partId);
    }
  } else if (scene && scene.clearPartHighlight) {
    scene.clearPartHighlight();
  }
}

/**
 * 实验词条（左栏）与场景同步。
 * 只有"单桥视图 + exp=1"时出现；收起时停止播放并清掉实验视觉。
 */
function applyExperiment(state) {
  if (!lab) return;

  const onBridge = Boolean(state && state.view === "bridge" && state.bridgeId);
  const bridge = onBridge ? BRIDGE_BY_ID.get(state.bridgeId) : null;
  if (!onBridge || !bridge) {
    lab.hide();
    stopLabPlayback();
    return;
  }

  const current = experimentState(state);
  const flow = labFlow(state.bridgeId);
  lab.show({
    bridge,
    flow,
    step: current.step,
    exploded: current.exploded,
    playing: labTimer !== null,
    load: current.load,
    loadText: labLoadText,
    forceColors: current.colors,
    showLoad: Boolean(scene && scene.setLabLoad),
    exaggerationLabel: labBadgeLabel || initialBadgeLabel(state.bridgeId),
    // 收起态：实验进行到哪一步、荷载多少、下沉几厘米，一眼能看到
    collapsed: !state.exp,
    readout: experimentReadout(state, flow),
  });
  if (state.exp) applyExperimentVisuals(state);
  bindSheet(els.labPanel);
}

/** 没拖过滑杆时，也先把这座桥的放大倍数算出来显示在徽标上。 */
function initialBadgeLabel(bridgeId) {
  const bridge = bridgeId ? BRIDGE_BY_ID.get(bridgeId) : null;
  if (!bridge) return "挠度曲线为放大示意";
  // 场景还没就绪时拿不到真实半跨，先用一个中性值；setLabLoad 回来后会用真实值覆盖
  const diagram = diagramFor(Number(bridge.deflectionBase) || 4, 1, 2.2);
  return `挠度曲线放大 ×${diagram.factor} · 教学示意`;
}

/** 实验读数：第几步 / 构件名 / 荷载百分比 / 下沉值，收起态与 HUD 共用。 */
function experimentReadout(state, flow) {
  const current = experimentState(state);
  const parts = [];
  if (Number.isInteger(current.step) && flow[current.step]) {
    parts.push(`第 ${current.step + 1}/${flow.length} 步 · ${flow[current.step]}`);
  } else {
    parts.push("未开始");
  }
  if (current.load > 0) parts.push(`荷载 ${Math.round(current.load * 100)}%`);
  if (current.exploded) parts.push("已拆解");
  return parts.join(" · ");
}

/**
 * 把实验的视觉状态落到场景上：受力配色 / 力流步骤 / 荷载与挠度。
 * 必须在 scene.setState 之后调用，否则会被 setState 里的高亮逻辑覆盖。
 */
/** 上一次落到场景上的高亮组合：相同就不重复重建幽灵网格。 */
let lastVisuals = { bridgeId: null, step: null, colors: null };

function applyExperimentVisuals(state) {
  if (!scene || !state || state.view !== "bridge" || !state.exp || !state.bridgeId) return;
  const current = experimentState(state);
  const bridgeId = state.bridgeId;
  const step = Number.isInteger(current.step) ? current.step : -1;

  // 载荷滑杆每 tick 都会进来；只有"桥/步/配色"变了才需要重画高亮。
  // 幂等之后，既省掉每帧重建幽灵网格，也避免回调链被高频触发。
  const sameHighlight =
    lastVisuals.bridgeId === bridgeId &&
    lastVisuals.step === step &&
    lastVisuals.colors === current.colors;

  if (!sameHighlight) {
    lastVisuals = { bridgeId, step, colors: current.colors };
    if (current.colors) {
      scene.colorizeForce(bridgeId, true);
    } else {
      scene.colorizeForce(bridgeId, false);
      scene.setForceStep(bridgeId, step);
    }
  }

  const info = scene.setLabLoad ? scene.setLabLoad(bridgeId, current.load) : null;
  if (info && info.exaggeration > 0) {
    labBadgeLabel = `挠度曲线放大 ×${info.exaggeration} · 教学示意`;
    labLoadText =
      info.load <= 0.001
        ? "拖到 0 以上看荷载怎么传下去。桥面上方那条曲线是放大后的挠度示意，不是精确计算。"
        : `跨中下沉约 ${info.realCm.toFixed(1)} cm——桥面上方的曲线按 ×${info.exaggeration} 放大绘制。`;
  } else {
    labLoadText = "";
  }

  if (lab && lab.isOpen) lab.show({ load: current.load, loadText: labLoadText });
}

function renderBrowse() {
  renderedView = "browse";
  if (els.app3d) els.app3d.hidden = true;
  if (els.legacyRoot) els.legacyRoot.hidden = false;
  document.body.classList.remove("a3d-active");
  if (scene) scene.stop();
  syncReturnButton(true);
  updateStatus({ view: "browse", bridgeId: null, exp: false, exploded: false });
}

function renderApp3d(state) {
  renderedView = state.view;
  if (els.legacyRoot) els.legacyRoot.hidden = true;
  if (els.app3d) els.app3d.hidden = false;
  document.body.classList.add("a3d-active");
  closeGuide();
  syncReturnButton(false);

  const text = describe(state);
  if (els.kicker) els.kicker.textContent = text.kicker;
  if (els.title) els.title.textContent = text.title;
  if (els.sub) els.sub.textContent = text.sub;

  for (const item of navItems) {
    item.classList.toggle("is-active", item.dataset.nav === state.view);
  }
  if (els.btnExperiment) {
    const expOn = Boolean(state.view === "bridge" && state.exp);
    els.btnExperiment.setAttribute("aria-pressed", expOn ? "true" : "false");
    els.btnExperiment.classList.toggle("is-active", expOn);
    els.btnExperiment.disabled = state.view !== "bridge";
  }
  if (els.bridgeList) {
    for (const link of els.bridgeList.querySelectorAll("a")) {
      const active = state.view === "bridge" && link.dataset.bridge === state.bridgeId;
      link.classList.toggle("is-active", active);
      link.setAttribute("aria-current", active ? "true" : "false");
    }
  }

  latestState = state;
  updateStatus(state);
  applyPanel(state);
  ensureSceneReady(state);
  applyExperiment(state);
}

/** file:// 打开时说明为什么进不了三维。 */
function explainFileProtocol() {
  if (!isFileProtocol) return;
  showBootNotice(
    "需要通过本地服务打开",
    "直接双击 index.html 时浏览器会以 file:// 加载，ES 模块与 WebGL 场景都不可用，因此先显示二维版本。请改双击 桥见柳州.exe（或 桥见柳州-手机访问.exe），它会启动本地服务。"
  );
}

function onChange(state, meta) {
  // 列表视图内的页内锚点、旧格式 hash 不应把我们切进 3D。
  if (!meta.initial && renderedView === "browse" && !isSceneRoute(window.location.hash)) {
    return;
  }

  if (state.legacy) {
    router.replace({ ...state, legacy: false });
  }

  if (browseOnly) {
    if (state.view !== "browse") {
      router.replace({ view: "browse", bridgeId: null, mode: "structure", exploded: false });
    }
    renderBrowse();
    return;
  }

  if (state.view === "browse") renderBrowse();
  else renderApp3d(state);
}

/* ---------------- 投屏排版与自助体验 ---------------- */

/** 投屏模式：键盘快速切桥（←/→ 逐桥、数字 1–5 直跳、Esc 回总览）。 */
function bindPresentKeys() {
  window.addEventListener("keydown", (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || event.target.isContentEditable) return;

    const state = router ? router.current : null;
    const order = BRIDGES.map((bridge) => bridge.id);
    const target = presentKeyToHash(event.key, state ? state.bridgeId : null, order);
    if (!target) return;
    event.preventDefault();
    window.location.hash = target;
  });
}

/** 自助巡览：定时推进；观众一操作就暂停，长时间空闲后复位继续。 */
function startKiosk() {
  const advance = () => {
    kioskIndex = (kioskIndex + 1) % KIOSK_STOPS.length;
    window.location.hash = KIOSK_STOPS[kioskIndex];
  };

  const schedule = () => {
    if (kioskTimer !== null) window.clearInterval(kioskTimer);
    kioskTimer = window.setInterval(() => {
      if (!kioskSuspended) advance();
    }, KIOSK_DWELL_MS);
  };

  const suspend = () => {
    kioskSuspended = true;
    document.body.classList.add("a3d-kiosk-paused");
    if (kioskResumeTimer !== null) window.clearTimeout(kioskResumeTimer);
    kioskResumeTimer = window.setTimeout(() => {
      // 长时间无操作：复位到总览，然后继续巡览
      kioskSuspended = false;
      kioskIndex = -1;
      document.body.classList.remove("a3d-kiosk-paused");
      window.location.hash = "#atlas";
    }, KIOSK_IDLE_RESUME_MS);
  };

  for (const type of ["pointerdown", "wheel", "keydown", "touchstart"]) {
    window.addEventListener(type, suspend, { passive: true });
  }

  advance();
  schedule();
}

function boot() {
  if (!els.app3d || !els.legacyRoot || !els.canvas) {
    console.warn("[app3d] 外壳节点缺失，保持现有 2D 页面不变。");
    return;
  }

  buildBridgeList();
  guardGuideIn3d();

  // 交付形态：只加 class，不改路由语义
  explainFileProtocol();

  if (showFlags.present) document.body.classList.add("a3d-present");
  if (showFlags.kiosk) {
    document.body.classList.add("a3d-kiosk");
    startKiosk();
  }
  if (showFlags.present) bindPresentKeys();

  if (els.labPanel) {
    lab = createLab(els.labPanel, {
      bridges: BRIDGES,
      profiles: PROFILES,
      legend: FORCE_LEGEND,
      goals: GOALS,
      onSelectBridge: (bridgeId) => {
        const state = router ? router.current : null;
        if (!state) return;
        // 换实验对象仍在单桥视图内：走参数通道，避免触发浏览器导航滚动
        applyStateParams({
          view: "bridge",
          bridgeId,
          exp: true,
          step: 0,
          exploded: false,
          load: null
        });
      },
      onSelectStep: (index) => {
        const state = router ? router.current : null;
        if (!state) return;
        stopLabPlayback();
        applyStateParams({ step: index, exp: true });
      },
      onTogglePlay: () => {
        const state = router ? router.current : null;
        if (!state) return;
        if (labTimer !== null) {
          stopLabPlayback();
          lab.show({ playing: false });
          return;
        }
        const flow = labFlow(state.bridgeId);
        if (flow.length === 0) return;
        let cursor = Number.isInteger(state.step) ? state.step : -1;
        const advance = () => {
          cursor = (cursor + 1) % flow.length;
          applyStateParams({ step: cursor, exp: true });
        };
        advance();
        labTimer = window.setInterval(advance, 1800);
        lab.show({ playing: true });
      },
      onToggleExplode: () => {
        const state = router ? router.current : null;
        if (!state) return;
        applyStateParams({ exploded: !state.exploded, exp: true });
      },
      onSetLoad: (value) => {
        const state = router ? router.current : null;
        if (!state) return;
        const load = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100) / 100;

        // 每一 tick 都重绘太贵、写地址更会打断拖拽：先把视觉落到场景上，
        // 地址用 replaceState 防抖写入（不导航、不滚动）。
        const next = { ...state, load: load === 0 ? null : load, exp: true };
        router.replace(next);
        latestState = next;
        applyExperimentVisuals(next);

        if (loadCommitTimer !== null) window.clearTimeout(loadCommitTimer);
        loadCommitTimer = window.setTimeout(() => {
          loadCommitTimer = null;
        }, 200);
      },
      onToggleColors: () => {
        const state = router ? router.current : null;
        if (!state) return;
        applyStateParams({ colors: !state.colors, exp: true });
      },
      onToggleCollapsed: () => {
        // 收起/展开实验词条：只翻转 exp，其余实验状态保持不变
        const state = router ? router.current : null;
        if (!state || state.view !== "bridge") return;
        applyStateParams({ exp: !state.exp });
      },
      onOpenBridge: () => {
        const state = router ? router.current : null;
        if (!state) return;
        applyStateParams({ exp: false });
      },
      onOpen2d: () => openLegacyLab()
    });
  }

  if (els.panel) {
    panel = createPanel(els.panel, {
      onPartSelect: (partId) => {
        const state = router ? router.current : null;
        if (state && state.view === "bridge") focusPart(state.bridgeId, partId);
      },
      onFocusBridge: (bridgeId) => {
        if (scene && scene.focusBridge) scene.focusBridge(bridgeId);
      },
      onOpenLab: () => openLegacyLab()
    });
  }

  if (els.btnBrowse) {
    els.btnBrowse.addEventListener("click", () => {
      window.location.hash = "#browse";
    });
  }

  if (els.btnExperiment) {
    els.btnExperiment.addEventListener("click", () => {
      const state = router ? router.current : null;
      if (!state || state.view !== "bridge") return;
      applyStateParams({ exp: !state.exp });
    });
  }
  if (els.btnReset) {
    els.btnReset.addEventListener("click", () => {
      if (scene) scene.resetView();
    });
  }

  if (els.bootBrowse) {
    els.bootBrowse.addEventListener("click", () => {
      if (els.bootNotice) els.bootNotice.hidden = true;
      window.location.hash = "#browse";
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (renderedView && renderedView !== "atlas" && renderedView !== "browse") {
      window.location.hash = "#atlas";
    }
  });

  router = createRouter(onChange);
  router.start();

  if (isFileProtocol) {
    showBootNotice(
      "需要通过本地服务器打开",
      "3D 场景依赖 ES module 与 WebGL，必须经 <code>http://</code> 访问。请在项目目录运行 <code>node server.js</code>，再打开 <code>http://127.0.0.1:4173</code>。当前先进入列表视图。"
    );
  }

  // 便于人工自检与后续里程碑调试。
  window.bridgeObservatory = {
    get showMode() {
      return { ...showFlags, kioskIndex, kioskSuspended };
    },
    get state() {
      return router ? router.current : null;
    },
    get scene() {
      return scene;
    },
    get capabilities() {
      return { isFileProtocol, webglAvailable, browseOnly };
    }
  };
}

boot();
