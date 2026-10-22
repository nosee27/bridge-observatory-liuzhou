/**
 * 前台 Overpass 查询 runner：query 从 UTF-8 文件读，避免 git-bash curl 的中文编码问题。
 * 任一镜像成功（含 4xx 业务失败仍写入 body 便于排查）即落盘。
 *   node overpass-run.mjs <query-file> <out-file>
 */
import fs from "node:fs";

const [, , qFile, outFile] = process.argv;
const query = fs.readFileSync(qFile, "utf8");
const UA = "bridge-observatory-liuzhou/1.0 (educational static site)";
const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

for (const server of SERVERS) {
  try {
    const response = await fetch(server, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(200000)
    });
    const text = await response.text();
    if (response.ok && text.includes('"elements"')) {
      fs.writeFileSync(outFile, text, "utf8");
      console.log(`ok ${server.split("/")[2]} ${text.length}B -> ${outFile}`);
      process.exit(0);
    }
    if (response.ok) {
      // ok 但无 elements（例如 out:csv）：直接落盘
      fs.writeFileSync(outFile, text, "utf8");
      console.log(`ok(non-json) ${server.split("/")[2]} ${text.length}B -> ${outFile}`);
      process.exit(0);
    }
    console.log(`${server.split("/")[2]} status=${response.status} len=${text.length}`);
  } catch (error) {
    console.log(`${server.split("/")[2]} ${error.message}`);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
process.exit(1);
