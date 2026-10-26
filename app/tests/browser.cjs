"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const { createRoomServer } = require("../server.cjs");
function sineWave() {
  const rate = 8000, samples = rate * 180, buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return buffer;
}
(async () => {
  const app = createRoomServer({ env: {}, authStore: null, hostGraceMs: 100 });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = process.env.MIKU_TEST_ORIGIN || `http://localhost:${app.server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge", headless: true });
  const errors = [];
  const watch = (page) => page.on("pageerror", (err) => errors.push(err.message));
  try {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
    for (const context of [hostContext, guestContext]) await context.addInitScript(() => {
      window.RTCPeerConnection = undefined;
      const NativeSocket = window.WebSocket; window.testSockets = [];
      window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.testSockets.push(this); } };
    });
    const host = await hostContext.newPage(), guest = await guestContext.newPage(); watch(host); watch(guest);
    if (origin.startsWith("https:")) { host.setDefaultTimeout(60000); guest.setDefaultTimeout(60000); }
    await host.goto(origin, { waitUntil: "domcontentloaded" }); await host.locator("#roomLaunch").click();
    await host.locator("#roomName").fill("初音房主"); await host.locator("#roomCreate").click();
    await host.locator("#roomActive").waitFor({ state: "visible" });
    const code = await host.locator("#roomActiveCode").innerText(); assert.match(code, /^[A-F0-9]{12}$/);
    if (origin.startsWith("https:")) {
      await hostContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      await host.locator("#roomCopy").click();
      assert.equal(await host.evaluate(() => navigator.clipboard.readText()), `${origin}/#room=${code}`);
      console.log("PASS: public HTTPS invitation copies a directly usable room link");
    }
    const originalId = await host.evaluate(() => JSON.parse(sessionStorage.getItem("mikuFocusRoom_v2")).id);
    await host.locator("#fileInput").setInputFiles({ name: "房主的旋律.wav", mimeType: "audio/wav", buffer: sineWave() });
    await host.waitForFunction(() => document.getElementById("roomSong").textContent === "房主的旋律");
    await host.locator("#btnPlay").click(); await host.waitForFunction(() => !document.getElementById("roomAudio").paused);
    await guest.goto(`${origin}/#room=${code}`, { waitUntil: "domcontentloaded" });
    await guest.locator("#roomName").fill("远方的朋友"); await guest.locator("#roomJoin").click();
    await guest.waitForFunction(() => document.querySelectorAll(".room-member").length === 2);
    if (await guest.locator("#roomAudio").evaluate((a) => a.paused)) await guest.locator("#roomListen").click();
    await guest.waitForFunction(() => !document.getElementById("roomAudio").paused && document.getElementById("roomAudio").currentTime > .1);
    await guest.evaluate(async () => {
      window.audioCheck = new AudioContext();
      const input = audioCheck.createMediaElementSource(document.getElementById("roomAudio"));
      window.analyser = audioCheck.createAnalyser(); input.connect(analyser); analyser.connect(audioCheck.destination); await audioCheck.resume();
      window.receivedRms = () => { const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((s, x) => s + x * x, 0) / data.length); };
    });
    await guest.waitForFunction(() => receivedRms() > .01);
    console.log("PASS: real non-silent shared audio over HTTP with WebRTC entirely unavailable");

    await guest.locator("#fileInput").setInputFiles({ name: "朋友添加的歌.wav", mimeType: "audio/wav", buffer: sineWave() });
    await guest.locator("#btnList").click(); await guest.locator(".pl-row").filter({ hasText: "朋友添加的歌" }).waitFor();
    await guest.locator(".pl-row").filter({ hasText: "朋友添加的歌" }).click();
    await host.waitForFunction(() => document.getElementById("roomSong").textContent === "朋友添加的歌");
    await guest.locator("#btnPlay").click(); await host.waitForFunction(() => document.getElementById("roomAudio").paused);
    await guest.locator("#btnPlay").click(); await host.waitForFunction(() => !document.getElementById("roomAudio").paused);
    await guest.locator("#seekBar").fill("100"); await guest.locator("#seekBar").dispatchEvent("change");
    await host.waitForFunction(() => document.getElementById("roomAudio").currentTime >= 14);
    await host.locator("#volBar").fill("0"); assert.equal(await guest.locator("#roomAudio").evaluate((a) => a.volume), .8);
    await guest.locator("#roomListen").click(); assert.equal(await guest.locator("#roomAudio").evaluate((a) => a.muted), true);
    assert.equal(await host.locator("#roomAudio").evaluate((a) => a.paused), false); await guest.locator("#roomListen").click();
    console.log("PASS: guests add/select/pause/play/seek; volume and personal listening stay independent");

    await host.locator("#btnStart").click(); await host.locator("#timerToggle").click(); await host.locator("#btnPause").click();
    await guest.waitForFunction(() => [...document.querySelectorAll(".room-member")].some((li) => li.textContent.includes("初音房主") && li.dataset.status === "paused"));
    assert.equal(await guest.locator("#roomAudio").evaluate((a) => a.paused), false);
    await host.reload({ waitUntil: "domcontentloaded" }); await host.locator("#roomActive").waitFor({ state: "visible" });
    assert.equal(await host.evaluate(() => JSON.parse(sessionStorage.getItem("mikuFocusRoom_v2")).id), originalId);
    await host.waitForFunction(() => document.querySelectorAll(".room-member").length === 2);
    assert.equal(await host.locator("#roomSong").innerText(), "朋友添加的歌");
    await guest.evaluate(() => testSockets.at(-1).close());
    await guest.waitForFunction(() => testSockets.length > 1 && testSockets.at(-1).readyState === WebSocket.OPEN);
    await guest.waitForFunction(() => document.getElementById("roomMessage").textContent.includes("已恢复"));
    await guest.waitForFunction(() => document.querySelectorAll(".room-member").length === 2);
    console.log("PASS: independent study states; refresh restores identity/queue; dropped socket reconnects automatically");

    await host.locator("#roomLeave").click();
    await guest.waitForFunction(() => !document.getElementById("roomEnd").hidden);
    assert.equal(await guest.locator("#roomSong").innerText(), "朋友添加的歌");
    await guest.waitForFunction(() => !document.getElementById("roomAudio").paused);
    console.log("PASS: host leaves; remaining member inherits room and music continues");

    fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
    await guest.locator("#btnList").click();
    await guest.screenshot({ path: path.join(__dirname, "../test-results/room-v2-desktop.png") });
    await guest.setViewportSize({ width: 390, height: 844 }); await guest.locator("#roomVolume").fill("35");
    assert.equal(await guest.locator("#roomAudio").evaluate((a) => a.volume), .35);
    const bounds = await guest.locator("#roomPanel").boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await guest.screenshot({ path: path.join(__dirname, "../test-results/room-v2-mobile.png") });
    await guest.locator("#roomEnd").click(); await guest.locator("#roomLobby").waitFor({ state: "visible" });
    assert.equal(await guest.locator("#roomAudio").evaluate((a) => a.getAttribute("src")), null);
    assert.equal(await guest.locator("#btnMode").isDisabled(), false);
    console.log("PASS: mobile fits; explicit end clears room audio and restores solo controls");

    const offline = await hostContext.newPage(); watch(offline);
    await offline.goto(pathToFileURL(path.join(__dirname, "../../index.html")).href, { waitUntil: "domcontentloaded" });
    await offline.locator("#btnStart").click(); assert.equal(await offline.locator("body").getAttribute("data-state"), "study");
    await offline.locator("#roomLaunch").click(); await offline.locator("#roomName").fill("离线用户"); await offline.locator("#roomCreate").click();
    assert.match(await offline.locator("#roomMessage").innerText(), /一键分享/);
    await offline.locator("#fileInput").setInputFiles({ name: "本地音乐.wav", mimeType: "audio/wav", buffer: sineWave() });
    await offline.locator("#musicLibraryModal").waitFor({ state: "visible" });
    await offline.locator("#libraryPlayAll").click();
    await offline.waitForFunction(() => document.getElementById("npName").textContent === "本地音乐");
    console.log("PASS: offline file:// timer and private local music still work");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); }
})().catch((err) => { console.error(err); process.exitCode = 1; });
