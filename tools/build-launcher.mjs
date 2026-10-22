/**
 * 编译免安装启动器：launcher/Program.cs → 桥见柳州.exe
 *
 * 用的是 Windows 自带的 .NET Framework 编译器（csc.exe），
 * 不下载任何东西、不依赖 Node 或管理员权限。
 *
 * 用法：
 *   node tools/build-launcher.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "launcher", "Program.cs");
const OUTPUT = path.join(ROOT, "桥见柳州.exe");

const candidates = [
  "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
  "C:/Windows/Microsoft.NET/Framework64/v3.5/csc.exe"
];

const csc = candidates.find((file) => fs.existsSync(file));
if (!csc) {
  console.error("没有找到 .NET Framework 的 csc.exe；启动器无法编译。");
  process.exit(1);
}

if (!fs.existsSync(SOURCE)) {
  console.error("缺少 launcher/Program.cs");
  process.exit(1);
}

const args = [
  "/nologo",
  "/target:winexe",
  "/optimize+",
  "/platform:anycpu",
  "/reference:System.Windows.Forms.dll",
  `/out:${OUTPUT}`,
  SOURCE
];

try {
  const output = execFileSync(csc, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  if (output.trim()) console.log(output.trim());
} catch (error) {
  console.error("编译失败：");
  console.error(String(error.stdout || "") + String(error.stderr || ""));
  process.exit(1);
}

const stat = fs.statSync(OUTPUT);
console.log(`已生成 ${path.basename(OUTPUT)}：${(stat.size / 1024).toFixed(0)} KB`);
console.log("双击即用：内置静态服务 + Edge/Chrome 独立窗口（无地址栏、无标签页）");
