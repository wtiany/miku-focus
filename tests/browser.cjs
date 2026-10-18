"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const { createRoomServer } = require("../server.cjs");

function sineWave() {
  const rate = 24000, samples = rate * 60;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return buffer;
}

(async () => {
  const app = createRoomServer({ env: { STUN_URL: "" } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://localhost:${app.server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge", headless: true });
  const errors = [];
  const watch = (page) => page.on("pageerror", (err) => errors.push(err.message));
  try {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    for (const session of [hostContext, guestContext]) await session.addInitScript(() => {
      const NativePeer = window.RTCPeerConnection;
      window.testPeers = [];
      window.RTCPeerConnection = class extends NativePeer {
        constructor(options) { super(options); window.testPeers.push(this); }
      };
    });
    const host = await hostContext.newPage(); watch(host);
    const guest = await guestContext.newPage(); watch(guest);
    await host.goto(origin);
    await host.locator("#roomLaunch").click();
    await host.locator("#roomName").fill("初音房主");
    await host.locator("#roomCreate").click();
    await host.locator("#roomActive").waitFor({ state: "visible" });
    const code = await host.locator("#roomActiveCode").innerText();
    assert.match(code, /^[A-F0-9]{12}$/);
    await host.locator("#fileInput").setInputFiles([
      { name: "测试旋律.wav", mimeType: "audio/wav", buffer: sineWave() },
      { name: "下一首.wav", mimeType: "audio/wav", buffer: sineWave() },
    ]);
    if (await host.locator("#audio").evaluate((a) => a.paused)) await host.locator("#btnPlay").click();
    await host.waitForFunction(() => !document.getElementById("audio").paused);
    await guest.goto(`${origin}/#room=${code}`);
    await guest.locator("#roomName").fill("远方的朋友");
    await guest.locator("#roomJoin").click();
    await guest.waitForFunction(() => document.querySelectorAll(".room-member").length === 2);
    await guest.waitForFunction(() => document.getElementById("roomAudio").srcObject?.getAudioTracks().some((t) => t.readyState === "live"), null, { timeout: 15000 });
    if (await guest.locator("#roomAudio").evaluate((a) => a.paused)) await guest.locator("#roomListen").click();
    await guest.waitForFunction(() => !document.getElementById("roomAudio").paused);

    // Verify actual received audio energy, not just a connected signaling socket.
    await guest.evaluate(async () => {
      window.audioCheck = new AudioContext();
      const input = audioCheck.createMediaStreamSource(document.getElementById("roomAudio").srcObject);
      window.analyser = audioCheck.createAnalyser(); input.connect(analyser); analyser.connect(audioCheck.destination);
      window.receivedRms = () => {
        const values = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(values);
        return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
      };
      await audioCheck.resume();
    });
    try {
      await guest.waitForFunction(() => receivedRms() > 0.01, null, { timeout: 10000 });
    } catch (err) {
      for (const [name, page] of [["host", host], ["guest", guest]]) console.log(name, await page.evaluate(async () => ({
        audio: { paused: document.getElementById("audio").paused, volume: document.getElementById("audio").volume, currentTime: document.getElementById("audio").currentTime },
        rms: window.receivedRms?.(), context: window.audioCheck?.state,
        peers: await Promise.all(testPeers.map(async (p) => ({ state: p.connectionState, stats: [...(await p.getStats()).values()].filter((s) => ["inbound-rtp", "outbound-rtp", "media-source"].includes(s.type)) }))),
        status: document.getElementById("roomMessage").textContent,
      })));
      throw err;
    }
    console.log("PASS: host local WAV -> WebRTC -> guest has non-silent audio");

    await host.locator("#volBar").evaluate((input) => { input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await guest.waitForFunction(() => receivedRms() > 0.01);
    assert.equal(await host.evaluate(() => mikuRoom.getLocalVolume()), 0);
    console.log("PASS: host volume does not mute the remote audio stream");

    await host.locator("#btnStart").click();
    // Timer becomes compact after moving away; use its accessible toggle to pin.
    await host.locator("#timerToggle").click();
    await host.locator("#btnPause").click();
    await guest.waitForFunction(() => [...document.querySelectorAll(".room-member")].some((li) => li.textContent.includes("初音房主") && li.dataset.status === "paused"));
    assert.equal(await host.locator("#audio").evaluate((a) => a.paused), false);
    await guest.waitForFunction(() => receivedRms() > 0.01);
    assert.equal(await guest.locator("#btnNext").isDisabled(), true);
    console.log("PASS: independent timer state is shared; personal pause does not stop music");

    await host.locator("#btnNext").click();
    await guest.waitForFunction(() => document.getElementById("roomSong").textContent === "下一首");
    await guest.waitForFunction(() => receivedRms() > 0.01);
    await guest.locator("#roomListen").click();
    assert.equal(await guest.locator("#roomAudio").evaluate((a) => a.muted), true);
    assert.equal(await host.locator("#audio").evaluate((a) => a.paused), false);
    await guest.locator("#roomListen").click();
    console.log("PASS: song changes propagate; guest can mute only their own listening");

    const lateGuest = await guestContext.newPage(); watch(lateGuest);
    await lateGuest.goto(`${origin}/#room=${code}`);
    await lateGuest.locator("#roomName").fill("晚到的朋友");
    await lateGuest.locator("#roomJoin").click();
    await lateGuest.waitForFunction(async () => {
      const pc = testPeers.at(-1);
      return pc && [...(await pc.getStats()).values()].some((s) => s.type === "inbound-rtp" && s.totalAudioEnergy > 0);
    });
    assert.equal(await lateGuest.locator("#roomSong").innerText(), "下一首");
    await lateGuest.locator("#roomLeave").click();
    await guest.waitForFunction(() => receivedRms() > 0.01);
    console.log("PASS: late join receives the current song without interrupting an existing listener");

    await guest.evaluate(() => testPeers.at(-1).close());
    await guest.locator("#roomListen").click();
    await guest.waitForFunction(async () => {
      const pc = testPeers.at(-1);
      return pc?.connectionState === "connected" && [...(await pc.getStats()).values()].some((s) => s.type === "inbound-rtp" && s.totalAudioEnergy > 0);
    });
    console.log("PASS: guest can reconnect an interrupted audio connection");

    fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
    await host.screenshot({ path: path.join(__dirname, "../test-results/room-desktop.png") });
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.locator("#roomVolume").fill("35");
    assert.equal(await guest.locator("#roomAudio").evaluate((a) => a.volume), .35);
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const bounds = await guest.locator("#roomPanel").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await guest.screenshot({ path: path.join(__dirname, "../test-results/room-mobile.png") });
    console.log("PASS: desktop/mobile layouts fit; mobile has independent room volume");

    await host.locator("#roomLeave").click();
    await guest.locator("#roomLobby").waitFor({ state: "visible" });
    assert.equal(await guest.locator("#roomAudio").evaluate((a) => a.srcObject), null);
    assert.equal(await guest.locator("#btnNext").isDisabled(), false);
    assert.equal(await host.locator("body").getAttribute("data-state"), "paused");
    console.log("PASS: host ending room releases guest audio and restores solo controls");

    await host.locator("#volBar").fill("50");
    await host.locator("#btnResume").click();
    await host.locator("#timerToggle").click();
    await host.locator("#btnPause").click();
    await host.waitForFunction(() => document.getElementById("audio").paused);
    await host.locator("#btnResume").click();
    await host.waitForFunction(() => !document.getElementById("audio").paused && mikuRoom.getLocalVolume() > .49);
    console.log("PASS: original solo music fade still works after leaving a hosted room");

    await host.locator("#roomCreate").click();
    await host.locator("#roomActive").waitFor({ state: "visible" });
    const secondCode = await host.locator("#roomActiveCode").innerText();
    await guest.locator("#roomCode").fill(secondCode);
    await guest.locator("#roomJoin").click();
    await guest.waitForFunction(async () => {
      const pc = testPeers.at(-1);
      return pc?.connectionState === "connected" && [...(await pc.getStats()).values()].some((s) => s.type === "inbound-rtp" && s.totalAudioEnergy > 0);
    });
    await host.locator("#roomLeave").click();
    console.log("PASS: same pages can create and join another room without losing audio");

    // Offline double-click still works and gives a useful explanation for rooms.
    const offline = await hostContext.newPage(); watch(offline);
    await offline.goto(pathToFileURL(path.join(__dirname, "../index.html")).href);
    await offline.locator("#btnStart").click();
    assert.equal(await offline.locator("body").getAttribute("data-state"), "study");
    await offline.locator("#roomLaunch").click();
    await offline.locator("#roomName").fill("离线用户");
    await offline.locator("#roomCreate").click();
    assert.match(await offline.locator("#roomMessage").innerText(), /启动学习房间/);
    console.log("PASS: file:// solo mode is preserved");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
