/**
 * 从 app.js 抽取权威数据 → app3d/bridges.data.mjs
 *
 * app.js 是 2D 页面的权威来源（经典脚本，不能 import）。3D 场景需要同一份
 * bridges / 构件说明 / 实验文案 / 档案来源 / 题库，为避免两处维护，这里把
 * app.js 里的几个顶层字面量抽出来生成 ES 模块。app.js 仍是唯一权威来源。
 *
 * 用法：
 *   node tools/build-bridge-data.mjs            # 生成
 *   node tools/build-bridge-data.mjs --check     # 只校验是否过期（退出码 1 = 过期）
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "app.js");
const TARGET = path.join(ROOT, "app3d", "bridges.data.mjs");

/**
 * 从 source[start] 开始（必须是 [ 或 { ），扫到配对的那个括号为止。
 * 手写扫描而不是正则：数据里有中文括号、字符串里也有分号，正则会被带偏。
 */
function readLiteral(source, start) {
  let depth = 0;
  let inString = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("字面量没有正常结束");
}

/** 定位 `const NAME = <literal>` 并求值。 */
function extract(source, name) {
  const marker = `const ${name} = `;
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`app.js 里找不到 \`${marker}\``);
  const literalStart = at + marker.length;
  const literal = readLiteral(source, literalStart);
  // 数据块是纯字面量（没有模板插值、没有外部引用），可以直接求值
  return new Function(`return ${literal}`)();
}

/** 把 app.js 里需要的几个顶层字面量都抽出来。 */
export function extractAll(source) {
  const picked = {
    BRIDGES: extract(source, "bridges"),
    PROFILES: extract(source, "comparisonProfiles"),
    GOALS: extract(source, "learningGoals"),
    SOURCES: extract(source, "bridgeSources"),
    SOURCE_LIBRARY: extract(source, "sourceLibrary"),
    QUIZ: extract(source, "quizQuestions")
  };
  if (!Array.isArray(picked.BRIDGES) || picked.BRIDGES.length === 0) {
    throw new Error("bridges 数据为空");
  }
  return picked;
}

/** 生成模块源码（测试用它做逐字节比对，保证文件与 app.js 一致）。 */
export function renderModule(picked) {
  const body = Object.entries(picked)
    .map(([key, value]) => `export const ${key} = ${JSON.stringify(value, null, 2)};`)
    .join("\n\n");

  return `/**
 * 自动生成，请勿手工编辑。
 *
 * 来源：app.js 里的顶层字面量（2D 页面的权威数据）——
 *   bridges / comparisonProfiles / learningGoals / bridgeSources
 *   / sourceLibrary / quizQuestions
 * 重新生成：node tools/build-bridge-data.mjs
 * 校验是否过期：node tools/build-bridge-data.mjs --check（tests 里也会跑）
 *
 * 3D 场景用这份数据渲染：桥梁资料卡、结构实验室的力流讲解与压拉配色、
 * 档案馆的档案卡与知识点来源、以及知识挑战题库。
 */

${body}

export const BRIDGE_BY_ID = new Map(BRIDGES.map((bridge) => [bridge.id, bridge]));
`;
}

function main() {
  const source = fs.readFileSync(SOURCE, "utf8");
  const picked = extractAll(source);
  const output = renderModule(picked);

  const check = process.argv.includes("--check");
  if (check) {
    const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n") : "";
    if (current === output) {
      console.log(
        `app3d/bridges.data.mjs 与 app.js 一致（${picked.BRIDGES.length} 座桥、` +
          `${picked.QUIZ.length} 道题）`
      );
      return;
    }
    console.error("app3d/bridges.data.mjs 已过期：请运行 node tools/build-bridge-data.mjs");
    process.exit(1);
  }

  fs.writeFileSync(TARGET, output, "utf8");
  const parts = picked.BRIDGES.reduce((sum, bridge) => sum + bridge.parts.length, 0);
  console.log(
    `已生成 app3d/bridges.data.mjs：${picked.BRIDGES.length} 座桥、${parts} 个构件、` +
      `${Object.keys(picked.PROFILES).length} 组桥型档案、${picked.QUIZ.length} 道题、` +
      `${(output.length / 1024).toFixed(1)} KB`
  );
}

// 只有直接运行时才写文件；被测试 import 时只提供函数
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invokedDirectly) main();
