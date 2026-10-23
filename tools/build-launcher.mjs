/**
 * 编译两个启动程序（共享 launcher/Program.cs，编译期用 LAN_EDITION 区分）：
 *
 *   桥见柳州.exe            本地版：只绑 127.0.0.1，只在本机开桌面窗口；不开放局域网、不碰防火墙
 *   桥见柳州-手机访问.exe    局域网版：绑 0.0.0.0，自动放行防火墙，只弹地址窗口（不开桌面窗口）
 *
 * 用 Windows 自带的 .NET Framework 编译器（csc.exe），不下载任何东西。
 *
 * 用法：node tools/build-launcher.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "launcher", "Program.cs");

const TARGETS = [
  { output: "桥见柳州.exe", define: null, label: "本地版" },
  { output: "桥见柳州-手机访问.exe", define: "LAN_EDITION", label: "局域网版（手机）" }
];

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

for (const target of TARGETS) {
  const output = path.join(ROOT, target.output);
  // 正在运行的 exe 会被锁住，先尝试清掉
  if (fs.existsSync(output)) {
    try {
      fs.unlinkSync(output);
    } catch {
      console.error(`无法覆盖 ${target.output}：它可能正在运行。请先关闭它再编译。`);
      process.exit(1);
    }
  }

  const args = [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/platform:anycpu",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll",
    ...(target.define ? [`/define:${target.define}`] : []),
    `/out:${output}`,
    SOURCE
  ];

  try {
    const stdout = execFileSync(csc, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    if (stdout.trim()) console.log(stdout.trim());
  } catch (error) {
    console.error(`编译 ${target.output} 失败：`);
    console.error(String(error.stdout || "") + String(error.stderr || ""));
    process.exit(1);
  }

  const size = fs.statSync(output).size;
  console.log(`已生成 ${target.output}（${target.label}）：${(size / 1024).toFixed(0)} KB`);
}

console.log("");
console.log("本地版：双击只在本机打开，不开放局域网、不改防火墙。");
console.log("局域网版：双击后弹窗显示手机地址，关闭该窗口即停止服务。");
