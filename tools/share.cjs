"use strict";
// Account-free HTTPS sharing via the official Cloudflare Quick Tunnel client.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createRoomServer } = require("../server.cjs");
const ROOT = path.resolve(__dirname, "..");
const CACHE = path.join(ROOT, ".tools");
const INFO = path.join(ROOT, ".share-info.json");
const tunnelUrl = (text) => text.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?![a-z0-9.-])/i)?.[0] || null;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function downloadClient() {
  if (process.env.CLOUDFLARED_PATH) return path.resolve(process.env.CLOUDFLARED_PATH);
  const assets = { "win32-x64": "cloudflared-windows-amd64.exe", "win32-ia32": "cloudflared-windows-386.exe", "linux-x64": "cloudflared-linux-amd64", "linux-arm64": "cloudflared-linux-arm64" };
  const name = assets[`${process.platform}-${process.arch}`];
  if (!name) throw new Error("请从 Cloudflare 官方下载适合本机的 cloudflared，并通过 CLOUDFLARED_PATH 指定路径。");
  await fs.mkdir(CACHE, { recursive: true });
  const destination = path.join(CACHE, name);
  try {
    const digest = (await fs.readFile(destination + ".sha256", "utf8")).trim();
    const actual = createHash("sha256").update(await fs.readFile(destination)).digest("hex");
    if (/^[a-f0-9]{64}$/.test(digest) && actual === digest) return destination;
  } catch {}
  console.log("首次启动：正在从 Cloudflare 官方 GitHub 下载分享工具，无需注册账号…");
  const releaseResponse = await fetch("https://api.github.com/repos/cloudflare/cloudflared/releases/latest", { headers: { "User-Agent": "miku-focus-share" }, signal: AbortSignal.timeout(30000) });
  if (!releaseResponse.ok) throw new Error(`无法获取官方工具版本（HTTP ${releaseResponse.status}），请检查网络后重试。`);
  const release = await releaseResponse.json();
  const asset = release.assets?.find((item) => item.name === name);
  if (!asset || !/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\//.test(asset.browser_download_url)) throw new Error("没有找到适合本机的官方分享工具。");
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) throw new Error("官方发布未提供 SHA-256 校验值，已停止自动下载。");
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}），请检查网络后重试。`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (`sha256:${digest}` !== asset.digest) throw new Error("分享工具校验失败，请重新运行。");
  await fs.writeFile(destination + ".download", bytes);
  await fs.rename(destination + ".download", destination);
  if (process.platform !== "win32") await fs.chmod(destination, 0o755);
  await fs.writeFile(destination + ".sha256", digest);
  return destination;
}
async function main() {
  console.log("初音未来 · 一键分享学习房间\n正在准备临时 HTTPS 链接。请保持此窗口与电脑开启。\n");
  const binary = await downloadClient();
  const env = { ...process.env, PUBLIC_ORIGIN: "" };
  const app = createRoomServer({ env });
  let child = null, stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true; child?.kill();
    await fs.unlink(INFO).catch(() => {});
    await app.close();
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop().then(() => process.exit(0)));
  try {
    await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
    const localOrigin = `http://127.0.0.1:${app.server.address().port}`;
    const configPath = path.join(CACHE, "quick-tunnel.yml");
    await fs.mkdir(CACHE, { recursive: true }); await fs.writeFile(configPath, "{}\n");
    child = spawn(binary, ["tunnel", "--config", configPath, "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", "--url", localOrigin], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const publicOrigin = await new Promise((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => reject(new Error("生成链接超时，请检查网络后重试。")), 60000);
      const read = (chunk) => {
        buffer = (buffer + chunk.toString()).slice(-12000);
        const found = tunnelUrl(buffer);
        if (found) { clearTimeout(timeout); resolve(found); }
      };
      child.stdout.on("data", read); child.stderr.on("data", read);
      child.once("error", (err) => { clearTimeout(timeout); reject(err); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`分享工具退出（${code}）。请检查网络后重试。`)); });
    });
    env.PUBLIC_ORIGIN = publicOrigin;
    console.log(`临时地址已生成：${publicOrigin}\n正在验证公网连接…`);
    let ready = false;
    for (let attempt = 0; attempt < 12 && !stopping; attempt++) {
      try {
        const response = await fetch(publicOrigin + "/health", { signal: AbortSignal.timeout(5000) });
        const health = await response.json();
        if (response.ok && health.service === "miku-focus-room" && health.protocol === 2) { ready = true; break; }
      } catch {}
      await pause(1500);
    }
    if (!ready) throw new Error("临时地址暂时无法访问，可能是当前网络无法连接 Cloudflare。请换网络后重试。");
    await fs.writeFile(INFO, JSON.stringify({ publicOrigin, localOrigin, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    console.log(`\n分享已就绪 ✓\n${publicOrigin}\n\n打开上面的页面 → 创建房间 → 复制邀请发给朋友。\n无需 TURN、域名或账号。音乐会临时保存在本机房间服务。\n关闭此窗口后链接失效，下次启动会生成新地址。\n`);
    if (process.env.MIKU_SHARE_NO_OPEN !== "1") {
      const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      const opener = spawn(command, [publicOrigin], { windowsHide: true, stdio: "ignore" }); opener.on("error", () => {}); opener.unref();
    }
    child.once("exit", () => { if (!stopping) { console.error("分享连接已停止，请重新运行一键分享。"); stop().then(() => { process.exitCode = 1; }); } });
    child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  } catch (err) { await stop(); throw err; }
}
if (require.main === module) main().catch((err) => { console.error(`\n无法启动分享：${err.message}`); process.exitCode = 1; });
module.exports = { tunnelUrl, downloadClient };
