"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { listLanAddresses } = require("./lan-addresses.js");

const root = __dirname;
const port = Number(process.env.PORT || 4173);

/*
 * 默认只绑定回环地址（127.0.0.1）：只有本机能访问，不会把项目目录暴露给同网段。
 * 加 --lan（或 LAN=1）则绑定 0.0.0.0，同一 Wi-Fi 下的手机/平板可以访问——
 * 这是移动端的启动方式；用完后关掉窗口即可。
 */
const wantLan = process.argv.includes("--lan") || process.env.LAN === "1";
const host = wantLan ? "0.0.0.0" : "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".hdr": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2"
};

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const decodedPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(root, relativePath);

  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, "index.html")) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(content);
  });
});

server.listen(port, host, () => {
  console.log(`桥见柳州已启动：http://127.0.0.1:${port}`);
  if (!wantLan) {
    console.log("（仅本机可访问。要让手机打开，用 start-lan.bat，或 node server.js --lan）");
    return;
  }

  const addresses = listLanAddresses();
  console.log("");
  console.log("手机 / 平板访问（需与电脑在同一个 Wi-Fi）：");
  if (addresses.length === 0) {
    console.log("  没有找到可用的局域网地址——请确认已连接 Wi-Fi 或网线。");
  } else {
    for (const item of addresses) {
      const hint = item.preferred ? "  ← 多半是这个" : "";
      console.log(`  http://${item.address}:${port}   (${item.name})${hint}`);
    }
  }
  console.log("");
  console.log("提示：Windows 首次可能弹出防火墙询问，请选择「允许访问」。");
  console.log("提示：这里会把整个项目目录开放给同网段，演示结束关掉窗口即可。");
});
