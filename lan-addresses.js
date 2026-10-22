"use strict";

/**
 * 局域网地址筛选（纯函数，便于断言）。
 *
 * 直接列 os.networkInterfaces() 会把三种"看着像但用不了"的地址一起打出来：
 *   - 198.18.0.0/15：本机 Clash 之类的 TUN 假地址（fake-ip），手机根本连不上；
 *   - 169.254.x.x：DHCP 失败时的自分配地址；
 *   - 回环与 IPv6：手机用不上。
 * 所以先过滤，再把 WLAN 一类接口排到最前——那通常就是要输入到手机里的那个。
 */

const os = require("node:os");

const FAKE_IP = /^198\.1[89]\./;
const SELF_ASSIGNED = /^169\.254\./;
const WIRELESS = /wlan|wi-?fi|wlp|wireless|无线/i;

function listLanAddresses(interfaces = os.networkInterfaces()) {
  const rows = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (FAKE_IP.test(entry.address) || SELF_ASSIGNED.test(entry.address)) continue;
      rows.push({ name, address: entry.address, preferred: WIRELESS.test(name) });
    }
  }
  rows.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

module.exports = { listLanAddresses, isUsableLanAddress };

function isUsableLanAddress(address) {
  return (
    typeof address === "string" &&
    /^\d+\.\d+\.\d+\.\d+$/.test(address) &&
    !FAKE_IP.test(address) &&
    !SELF_ASSIGNED.test(address) &&
    !address.startsWith("127.")
  );
}
