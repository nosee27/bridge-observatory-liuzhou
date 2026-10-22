/**
 * 手机连不上时的自查工具（只读，不改任何系统设置）。
 *
 * 用法：
 *   node tools/lan-doctor.mjs            诊断默认端口 4173
 *   node tools/lan-doctor.mjs --port=4174
 *
 * 它只回答三个问题：
 *   1. 现在有没有服务在跑？绑的是 127.0.0.1 还是 0.0.0.0？（绑回环 = 手机必然连不上）
 *   2. 防火墙认不认这个程序？（Windows 的入站规则按「程序 + 网络配置文件」匹配，
 *      常见坑：规则只对 Public 生效，而家里的 Wi-Fi 是 Private）
 *   3. 该抄哪个地址给手机？
 *
 * 不做的事：不自动改防火墙（那需要管理员，且不该在用户不知情时改系统设置），
 * 只把要执行的命令打印出来，配合仓库里的「允许手机访问.bat」双击即可。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const PORT = portArg ? Number(portArg.split("=")[1]) : 4173;

const lines = [];
const say = (text = "") => {
  lines.push(text);
  console.log(text);
};

const run = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: "pipe", windowsHide: true });
  } catch (error) {
    return String(error.stdout || "") + String(error.stderr || "");
  }
};

/* ---------------- 1) 监听状态 ---------------- */

say("== 1. 服务是否在监听 ==");
const netstat = run("netstat", ["-ano", "-p", "TCP"]);
const listeners = [];
for (const raw of netstat.split(/\r?\n/)) {
  const match = raw.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
  if (!match) continue;
  const localPort = Number(match[2]);
  if (localPort < PORT || localPort > PORT + 19) continue;
  listeners.push({ address: match[1], port: localPort, pid: Number(match[3]) });
}

if (listeners.length === 0) {
  say(`  ✗ ${PORT}–${PORT + 19} 上没有任何监听`);
  say("     → 先启动服务：双击 start-mobile.bat，或运行 node server.js --lan");
} else {
  for (const item of listeners) {
    const lan = item.address === "0.0.0.0" || item.address === "[::]";
    say(`  ${lan ? "✓" : "✗"} 端口 ${item.port} 绑定 ${item.address}  PID ${item.pid}${lan ? "" : "  ← 只绑回环，手机连不上"}`);
  }
  const lanListeners = listeners.filter((item) => item.address === "0.0.0.0" || item.address === "[::]");
  if (lanListeners.length > 1) {
    say("  ! 有多个对外开放的监听，端口可能和终端里打印的不一致");
  }
  if (lanListeners.length === 0) {
    say("     → 当前实例没开 --lan，手机一定连不上：改用 start-mobile.bat / node server.js --lan");
  }
}

/* ---------------- 2) 防火墙 ---------------- */

say();
say("== 2. 防火墙是否放行这个程序 ==");
const profiles = run("powershell", [
  "-NoProfile",
  "-Command",
  "Get-NetFirewallProfile | ForEach-Object { \"$($_.Name):$($_.Enabled)\" }"
])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
say(`  ${profiles.length ? profiles.join("  ") : "（读不到防火墙状态）"}`);

const category = run("powershell", [
  "-NoProfile",
  "-Command",
  "Get-NetConnectionProfile | ForEach-Object { \"$($_.Name)|$($_.NetworkCategory)|$($_.InterfaceAlias)\" }"
])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
say("  当前网络：");
for (const item of category) {
  const [name, kind, alias] = item.split("|");
  say(`    ${alias}  「${name}」  类型 ${kind}`);
}

const rulesRaw = run("powershell", [
  "-NoProfile",
  "-Command",
  "Get-NetFirewallApplicationFilter | Where-Object { $_.Program } | ForEach-Object { $r = $_ | Get-NetFirewallRule; \"$($r.DisplayName)|$($r.Direction)|$($r.Action)|$($r.Enabled)|$($r.Profile)|$($_.Program)\" }"
]);

const wantedPrograms = [
  { label: "node.exe", program: process.execPath },
  { label: "桥见柳州.exe", program: path.join(ROOT, "桥见柳州.exe") }
];

const ruleRows = rulesRaw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.includes("|"))
  .map((line) => {
    const [displayName, direction, action, enabled, profile, program] = line.split("|");
    return { displayName, direction, action, enabled, profile, program };
  });

const profilesForLan = category
  .filter((item) => item.split("|")[2] !== "ZeroTier One" && !(item.split("|")[0] || "").includes("ZeroTier"))
  .map((item) => (item.split("|")[1] || "").toLowerCase())
  .filter(Boolean);

say("  入站放行规则：");
for (const target of wantedPrograms) {
  if (!fs.existsSync(target.program)) {
    say(`    - ${target.label}: 文件不存在（${target.program}）`);
    continue;
  }
  const matched = ruleRows.filter(
    (row) =>
      row.program &&
      row.program.toLowerCase() === target.program.toLowerCase() &&
      row.direction === "Inbound" &&
      row.action === "Allow" &&
      String(row.enabled) === "True"
  );
  if (matched.length === 0) {
    say(`    ✗ ${target.label}: 没有任何入站放行规则 → 手机会被防火墙拦掉`);
  } else {
    for (const row of matched) {
      const covers = profilesForLan.every((kind) => String(row.profile).toLowerCase().includes(kind));
      say(`    ${covers ? "✓" : "!"} ${target.label}: 「${row.displayName}」 作用于 ${row.profile}${covers ? "" : `  ← 当前网络是 ${profilesForLan.join("/") || "?"}，规则不覆盖`}`);
    }
  }
}

/* ---------------- 3) 该抄哪个地址 ---------------- */

say();
say("== 3. 手机该输入哪个地址 ==");
const addresses = [];
for (const [name, entries] of Object.entries(os.networkInterfaces())) {
  for (const entry of entries || []) {
    if (entry.family !== "IPv4" || entry.internal) continue;
    if (/^198\.1[89]\./.test(entry.address) || /^169\.254\./.test(entry.address)) continue;
    addresses.push({ name, address: entry.address, wireless: /wlan|wi-?fi|无线/i.test(name) });
  }
}
addresses.sort((a, b) => Number(b.wireless) - Number(a.wireless));

if (addresses.length === 0) {
  say("  ✗ 没有可用的局域网地址（没连 Wi-Fi？）");
} else {
  for (const item of addresses.slice(0, 3)) {
    say(`  ${item.wireless ? "→" : " "} http://${item.address}:${PORT}   (${item.name})`);
  }
}

/* ---------------- 4) 结论 ---------------- */

say();
say("== 结论与下一步 ==");
const boundLan = listeners.some((item) => item.address === "0.0.0.0" || item.address === "[::]");
const needsFirewall = wantedPrograms.some((target) => {
  if (!fs.existsSync(target.program)) return false;
  const matched = ruleRows.filter(
    (row) =>
      row.program &&
      row.program.toLowerCase() === target.program.toLowerCase() &&
      row.direction === "Inbound" &&
      row.action === "Allow" &&
      String(row.enabled) === "True" &&
      profilesForLan.every((kind) => String(row.profile).toLowerCase().includes(kind))
  );
  return matched.length === 0;
});

if (!boundLan) {
  say("  ① 先启动「手机访问」模式：双击 start-mobile.bat（内部是 桥见柳州.exe --lan）");
}
if (needsFirewall) {
  say("  ② 防火墙没放行：双击「允许手机访问.bat」（会弹管理员授权），然后再试手机");
}
if (boundLan && !needsFirewall) {
  say("  ①② 都正常。如果手机还是打不开，多半是路由器/校园网的「设备隔离」(AP isolation)：");
  say("      换手机开热点、电脑连热点，通常立刻可用。");
}
say();
say("  仍不行时的兜底：把作品部署到静态托管（GitHub Pages 等），手机直接开网址，与网络环境无关。");
