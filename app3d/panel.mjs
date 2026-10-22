/**
 * 3D 资料词条（右栏）。
 *
 * 一座桥的全部"读"内容都在这一栏里，靠滚动 + 吸顶小导航切换分区：
 *   概览 / 构件 / 观察 / 来源 / 对比 / 答题
 *
 * 数据全部来自 app3d/bridges.data.mjs（由 app.js 抽取），所以这里的文案与 2D 章节一致。
 *
 * 交互约定：
 *   - 点构件行 → 回传给场景做高亮；场景里点构件 → 词条滚到那一行；
 *   - 没有单独几何的构件（如"跨中"）只展示说明，不假装能高亮；
 *   - 对比是"串行对比"：A 是当前桥，B 可以换，镜头可分别飞过去；
 *   - 答题进度写 localStorage（键 bridge-observatory-quiz），与 2D 的探索进度并存。
 */

const PANEL_CLASS = "a3d-panel";
const QUIZ_STORAGE_KEY = "bridge-observatory-quiz";

const SECTIONS = [
  { id: "overview", label: "概览" },
  { id: "parts", label: "构件" },
  { id: "observe", label: "观察" },
  { id: "sources", label: "来源" },
  { id: "compare", label: "对比" },
  { id: "quiz", label: "答题" }
];

const COMPARE_ROWS = [
  { key: "force", label: "受力特点" },
  { key: "members", label: "主要构件" },
  { key: "scene", label: "适用场景" },
  { key: "question", label: "思考题" }
];

const LETTERS = ["A", "B", "C", "D", "E"];

function readQuizProgress() {
  try {
    const raw = window.localStorage.getItem(QUIZ_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeQuizProgress(done) {
  try {
    window.localStorage.setItem(QUIZ_STORAGE_KEY, JSON.stringify([...done]));
  } catch {
    // 隐私模式/存储被禁用时不影响答题，只是不记忆
  }
}

export function createPanel(host, options = {}) {
  if (!host) throw new Error("资料词条缺少宿主节点");

  const { onPartSelect, onOpenLab, onFocusBridge } = options;

  let bridge = null;
  let modeled = new Set();
  let activePart = null;
  let extras = {};
  let els = null;
  let done = readQuizProgress();
  let compareTarget = null;

  host.classList.add(PANEL_CLASS);

  const section = (id, title) => {
    const element = document.createElement("section");
    element.className = "a3d-section";
    element.dataset.section = id;
    element.id = `a3d-section-${id}`;
    const heading = document.createElement("h3");
    heading.textContent = title;
    element.append(heading);
    return element;
  };

  /* ---------------- 各分区 ---------------- */

  function buildOverview() {
    const element = section("overview", "概览");
    if (bridge.tagline) {
      const tagline = document.createElement("p");
      tagline.className = "a3d-panel-tagline";
      tagline.textContent = bridge.tagline;
      element.append(tagline);
    }
    if (bridge.description) {
      const desc = document.createElement("p");
      desc.className = "a3d-panel-desc";
      desc.textContent = bridge.description;
      element.append(desc);
    }
    if (bridge.tag) {
      const tag = document.createElement("p");
      tag.className = "a3d-panel-note";
      tag.textContent = bridge.tag;
      element.append(tag);
    }
    return element;
  }

  function buildParts() {
    const element = section("parts", "关键构件");
    const list = document.createElement("ul");
    list.className = "a3d-panel-parts";
    const rows = new Map();

    for (const part of bridge.parts || []) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "a3d-part";
      button.dataset.part = part.id;
      const canHighlight = modeled.has(part.id);
      button.classList.toggle("is-modeled", canHighlight);
      button.title = canHighlight ? "在 3D 模型里高亮这个构件" : "该构件没有单独建模，仅作说明";

      const dot = document.createElement("i");
      dot.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      const label = document.createElement("strong");
      label.textContent = part.label;
      const detail = document.createElement("small");
      detail.textContent = part.description;
      text.append(label, detail);
      button.append(dot, text);
      button.addEventListener("click", () => {
        if (!canHighlight || !onPartSelect) return;
        onPartSelect(part.id);
      });

      item.append(button);
      list.append(item);
      rows.set(part.id, button);
    }

    element.append(list);

    const current = document.createElement("div");
    current.className = "a3d-panel-current";
    current.hidden = true;
    current.setAttribute("aria-live", "polite");
    element.append(current);

    return { element, rows, current };
  }

  function buildObserve() {
    const element = section("observe", "观察要点");
    if (bridge.observation) {
      const note = document.createElement("p");
      note.className = "a3d-panel-note";
      note.textContent = bridge.observation;
      element.append(note);
    }
    if (bridge.tip) {
      const tip = document.createElement("p");
      tip.className = "a3d-panel-desc";
      tip.textContent = bridge.tip;
      element.append(tip);
    }
    const goal = extras.goals && extras.goals[bridge.model];
    if (goal) {
      const goalLine = document.createElement("p");
      goalLine.className = "a3d-panel-desc";
      goalLine.textContent = `学习目标：${goal}`;
      element.append(goalLine);
    }
    return element;
  }

  function buildSources() {
    const element = section("sources", "资料来源");
    const ids = (extras.sources && extras.sources[bridge.id]) || [];
    const library = extras.sourceLibrary || {};
    const list = document.createElement("ul");
    list.className = "a3d-sources";
    for (const id of ids) {
      const item = library[id];
      if (!item) continue;
      const li = document.createElement("li");
      if (item.url) {
        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        link.textContent = item.name || item.url;
        li.append(link);
      } else {
        li.textContent = item.name || String(id);
      }
      list.append(li);
    }
    if (list.children.length === 0) {
      const empty = document.createElement("p");
      empty.className = "a3d-panel-note";
      empty.textContent = "这座桥暂无单独来源条目。";
      element.append(empty);
    } else {
      element.append(list);
    }
    return element;
  }

  function buildCompare() {
    const element = section("compare", "对比");
    const note = document.createElement("p");
    note.className = "a3d-panel-note";
    note.textContent = "串行对比：A 是当前这座桥，B 可以换；镜头可分别飞过去看。";
    element.append(note);

    const picker = document.createElement("div");
    picker.className = "a3d-compare-pick";
    const label = document.createElement("span");
    label.className = "a3d-lab-slotlabel";
    label.textContent = "B";
    const chips = document.createElement("div");
    chips.className = "a3d-lab-chips";
    const chipButtons = new Map();

    for (const item of extras.bridges || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "a3d-lab-chip";
      button.dataset.bridge = item.id;
      button.textContent = item.name.replace("大桥", "").replace("桥", "");
      button.addEventListener("click", () => {
        compareTarget = compareTarget === item.id ? null : item.id;
        renderCompare();
      });
      chips.append(button);
      chipButtons.set(item.id, button);
    }
    picker.append(label, chips);

    const table = document.createElement("table");
    table.className = "a3d-lab-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const text of ["对比项", "A", "B"]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = text;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);

    const actions = document.createElement("div");
    actions.className = "a3d-lab-tools";
    const focusB = document.createElement("button");
    focusB.type = "button";
    focusB.className = "a3d-lab-tool";
    focusB.textContent = "镜头 → B";
    focusB.addEventListener("click", () => {
      if (compareTarget && onFocusBridge) onFocusBridge(compareTarget);
    });
    actions.append(focusB);

    element.append(picker, table, actions);
    return { element, chipButtons, tbody, focusB };
  }

  function buildQuiz() {
    const element = section("quiz", "答题");
    const progress = document.createElement("p");
    progress.className = "a3d-panel-note";
    element.append(progress);

    const list = document.createElement("ol");
    list.className = "a3d-quiz";
    const cards = [];

    const quiz = extras.quiz || [];
    for (let index = 0; index < quiz.length; index += 1) {
      const question = quiz[index];
      const item = document.createElement("li");
      item.className = "a3d-quiz-card";

      const head = document.createElement("p");
      head.className = "a3d-quiz-question";
      head.textContent = `${index + 1}. ${question.question}`;

      const options = document.createElement("div");
      options.className = "a3d-quiz-options";
      const optionButtons = [];

      question.options.forEach((text, optionIndex) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "a3d-quiz-option";
        button.dataset.option = String(optionIndex);
        const badge = document.createElement("span");
        badge.className = "a3d-quiz-letter";
        badge.textContent = LETTERS[optionIndex] || String(optionIndex + 1);
        const body = document.createElement("span");
        body.textContent = text;
        button.append(badge, body);
        button.addEventListener("click", () => {
          const correct = optionIndex === question.answer;
          optionButtons.forEach((entry, entryIndex) => {
            entry.disabled = true;
            entry.classList.toggle("is-correct", entryIndex === question.answer);
            entry.classList.toggle("is-wrong", entryIndex === optionIndex && !correct);
          });
          explanation.hidden = false;
          if (correct) {
            done.add(index);
            writeQuizProgress(done);
            updateQuizProgress(progress);
          }
        });
        options.append(button);
        optionButtons.push(button);
      });

      const explanation = document.createElement("p");
      explanation.className = "a3d-quiz-explanation";
      explanation.hidden = true;
      explanation.textContent = question.explanation || "";

      item.append(head, options, explanation);
      list.append(item);
      cards.push({ item, optionButtons, explanation, index });
    }

    element.append(list);
    updateQuizProgress(progress);
    return { element, progress, cards };
  }

  function updateQuizProgress(element) {
    const total = (extras.quiz || []).length;
    element.textContent = total
      ? `已答对 ${done.size} / ${total} 题（进度会记住）。`
      : "暂无题目。";
  }

  function renderCompare() {
    if (!els) return;
    for (const [id, button] of els.compareChips) {
      const active = compareTarget === id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    els.compareFocus.disabled = !compareTarget;

    const profileA = extras.profiles && extras.profiles[bridge.model];
    const targetBridge = (extras.bridges || []).find((item) => item.id === compareTarget);
    const profileB = targetBridge && extras.profiles ? extras.profiles[targetBridge.model] : null;

    const rows = COMPARE_ROWS.map((row) => ({
      label: row.label,
      a: profileA ? profileA[row.key] : "",
      b: profileB ? profileB[row.key] : ""
    }));
    rows.push({
      label: "学习目标",
      a: extras.goals ? extras.goals[bridge.model] : "",
      b: targetBridge && extras.goals ? extras.goals[targetBridge.model] : ""
    });

    els.compareBody.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = row.label;
      const tdA = document.createElement("td");
      tdA.textContent = row.a || "—";
      const tdB = document.createElement("td");
      tdB.textContent = row.b || "—";
      if (row.a && row.b && row.a !== row.b) tr.classList.add("is-diff");
      tr.append(th, tdA, tdB);
      els.compareBody.append(tr);
    }
  }

  /* ---------------- 组装 ---------------- */

  function build() {
    host.innerHTML = "";
    host.hidden = false;

    const header = document.createElement("header");
    header.className = "a3d-panel-head";
    const title = document.createElement("div");
    title.className = "a3d-panel-title";
    const order = document.createElement("span");
    order.className = "a3d-panel-order";
    order.textContent = bridge.order;
    const name = document.createElement("h2");
    name.textContent = bridge.name;
    title.append(order, name);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "a3d-panel-close";
    closeButton.setAttribute("aria-label", "回到总览");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => {
      window.location.hash = "#atlas";
    });
    header.append(title, closeButton);

    const alias = document.createElement("p");
    alias.className = "a3d-panel-alias";
    alias.textContent = bridge.alias || "";

    const meta = document.createElement("dl");
    meta.className = "a3d-panel-meta";
    for (const [term, value] of [
      ["年代", bridge.year],
      ["桥型", bridge.type],
      ["结构", bridge.family],
      ["规模", bridge.size]
    ]) {
      if (!value) continue;
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      meta.append(dt, dd);
    }

    // 吸顶小导航：长滚动里必须能一步跳过去
    const nav = document.createElement("nav");
    nav.className = "a3d-sections-nav";
    nav.setAttribute("aria-label", "资料分区");
    const navButtons = new Map();
    for (const item of SECTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "a3d-section-link";
      button.dataset.section = item.id;
      button.textContent = item.label;
      button.addEventListener("click", () => {
        const target = host.querySelector(`#a3d-section-${item.id}`);
        if (target && target.scrollIntoView) target.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      nav.append(button);
      navButtons.set(item.id, button);
    }

    const body = document.createElement("div");
    body.className = "a3d-panel-body";

    const parts = buildParts();
    const compare = buildCompare();
    const quiz = buildQuiz();
    body.append(
      buildOverview(),
      parts.element,
      buildObserve(),
      buildSources(),
      compare.element,
      quiz.element
    );

    host.append(header, alias, meta, nav, body);

    els = {
      rows: parts.rows,
      current: parts.current,
      navButtons,
      body,
      compareChips: compare.chipButtons,
      compareBody: compare.tbody,
      compareFocus: compare.focusB,
      quizProgress: quiz.progress
    };

    setActivePart(null);
    renderCompare();
  }

  /**
   * 标记当前高亮构件（null = 清除）。
   *
   * scroll=false 用于"场景自动同步"：载荷滑杆每一 tick 都会重放力流步骤，
   * 若每次都 scrollIntoView，会把正在读答题/来源的用户一路拽回"构件"分区。
   */
  function setActivePart(partId, { scroll = true } = {}) {
    activePart = partId;
    if (!els) return;
    for (const [id, row] of els.rows) row.classList.toggle("is-active", id === partId);
    if (!partId) {
      els.current.hidden = true;
      els.current.innerHTML = "";
      return;
    }
    const part = (bridge.parts || []).find((entry) => entry.id === partId);
    els.current.hidden = false;
    els.current.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = part ? part.label : partId;
    const text = document.createElement("span");
    text.textContent = part ? part.description : "这个构件在资料里没有单独条目，仅作结构示意。";
    els.current.append(strong, text);
    if (scroll && els.rows.has(partId)) {
      els.rows.get(partId).scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  return {
    show(nextBridge, options2 = {}) {
      const changed = bridge !== nextBridge;
      bridge = nextBridge;
      modeled = new Set(options2.modeled || []);
      extras = {
        profiles: options2.profiles || {},
        goals: options2.goals || {},
        sources: options2.sources || {},
        sourceLibrary: options2.sourceLibrary || {},
        quiz: options2.quiz || [],
        bridges: options2.bridges || []
      };
      if (changed || !els) {
        compareTarget = null;
        build();
      }
      setActivePart(options2.partId || null, { scroll: Boolean(options2.scroll) });
    },
    hide() {
      host.hidden = true;
      host.innerHTML = "";
      els = null;
      bridge = null;
      activePart = null;
    },
    setModeled(ids) {
      modeled = new Set(ids || []);
      if (!els) return;
      for (const [id, row] of els.rows) row.classList.toggle("is-modeled", modeled.has(id));
    },
    focusPart(partId, options3 = {}) {
      if (!els) return;
      setActivePart(partId, options3);
    },
    get isOpen() {
      return Boolean(els) && !host.hidden;
    },
    get partId() {
      return activePart;
    }
  };
}
