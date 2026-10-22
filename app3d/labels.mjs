/**
 * 场景标签：把 3D 锚点投影成 DOM 标签。
 *
 * 用 DOM 而不是贴图，是为了复用现有字体、保证清晰度，并让标签可以被点击
 * （键盘用户的等价入口是左下 HUD 里的桥梁按钮，所以这里标 aria-hidden）。
 */

import * as THREE from "../vendor/three/three.module.min.js";

export function createLabels(layer, items, options = {}) {
  const onSelect = options.onSelect || (() => {});
  const nodes = new Map();
  const projected = new THREE.Vector3();

  for (const item of items) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `a3d-label a3d-label-${item.type}`;
    node.dataset.key = item.key;
    node.tabIndex = -1;
    node.setAttribute("aria-hidden", "true");
    node.style.setProperty("--label-accent", item.accent || "#9fd8e0");

    const dot = document.createElement("span");
    dot.className = "a3d-label-dot";
    const text = document.createElement("span");
    text.className = "a3d-label-text";
    text.textContent = item.text;
    const sub = document.createElement("span");
    sub.className = "a3d-label-sub";
    sub.textContent = item.sub;

    node.append(dot, text, sub);
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSelect({ type: item.type, id: item.id });
    });

    layer.append(node);
    nodes.set(item.key, { node, anchor: item.position.clone() });
  }

  let activeKey = null;

  function setActive(key) {
    if (activeKey === key) return;
    const previous = activeKey ? nodes.get(activeKey) : null;
    if (previous) previous.node.classList.remove("is-active");
    activeKey = key;
    const next = key ? nodes.get(key) : null;
    if (next) next.node.classList.add("is-active");
  }

  function update(camera, width, height) {
    if (!width || !height) return;
    for (const { node, anchor } of nodes.values()) {
      projected.copy(anchor).project(camera);
      const visible =
        projected.z > -1 &&
        projected.z < 1 &&
        Math.abs(projected.x) < 1.25 &&
        Math.abs(projected.y) < 1.25;

      if (!visible) {
        node.style.visibility = "hidden";
        continue;
      }

      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      node.style.visibility = "visible";
      node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }

  function dispose() {
    for (const { node } of nodes.values()) node.remove();
    nodes.clear();
  }

  return { update, setActive, dispose };
}
