"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const { createRoomServer } = require("../server.cjs");

async function start(t) {
  const app = createRoomServer({ env: { STUN_URL: "" } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, origin };
}
async function client(origin) {
  const ws = new WebSocket(origin.replace("http", "ws") + "/room", { origin });
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    const index = waiters.findIndex((w) => w.match(msg));
    if (index >= 0) { const [w] = waiters.splice(index, 1); clearTimeout(w.timer); w.resolve(msg); }
    else queue.push(msg);
  });
  function next(type, predicate = () => true) {
    const match = (msg) => msg.type === type && predicate(msg);
    const index = queue.findIndex(match);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3000) };
      waiters.push(waiter);
    });
  }
  const welcome = await next("welcome");
  return { ws, id: welcome.id, next, send: (msg) => ws.send(JSON.stringify(msg)), queue };
}

test("public assets, byte ranges, and private-file denial", async (t) => {
  const { origin } = await start(t);
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(origin + "/health")).status, 200);
  for (const file of ["/.env", "/.git/config", "/server.cjs", "/package.json", "/tools/repkg.py", "/assets/../server.cjs"]) {
    assert.equal((await fetch(origin + file)).status, 404, file);
  }
  const partial = await fetch(origin + "/assets/videos/miku_sea_color.mp4", { headers: { Range: "bytes=0-31" } });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 32);
  const invalid = await fetch(origin + "/assets/videos/miku_sea_color.mp4", { headers: { Range: "bytes=999999999-" } });
  assert.equal(invalid.status, 416);
});

test("room membership, track ownership, study states and cleanup", async (t) => {
  const { origin } = await start(t);
  const host = await client(origin);
  host.send({ type: "create", name: "房主" });
  const created = await host.next("room");
  assert.match(created.code, /^[A-F0-9]{12}$/);
  const guest = await client(origin);
  guest.send({ type: "join", name: "朋友", code: created.code.toLowerCase() });
  const joined = await guest.next("room");
  assert.equal(joined.members.length, 2);
  guest.send({ type: "track", name: "unauthorized", playing: true });
  guest.send({ type: "study", status: "study", elapsedMs: 1234 });
  const study = await guest.next("room", (m) => m.members.some((c) => c.id === guest.id && c.status === "study"));
  assert.notEqual(study.track.name, "unauthorized");
  host.send({ type: "track", name: "本地歌曲", playing: true });
  assert.equal((await guest.next("room", (m) => m.track.name === "本地歌曲")).track.playing, true);
  guest.send({ type: "signal", to: host.id, signal: { kind: "ready" } });
  assert.equal((await host.next("signal")).from, guest.id);
  host.send({ type: "leave" });
  await guest.next("ended");
  await host.next("left");
  const late = await client(origin);
  late.send({ type: "join", name: "晚到", code: created.code });
  assert.match((await late.next("error")).message, /不存在/);
});

test("six-person limit and no cross-room signaling", async (t) => {
  const { origin } = await start(t);
  const host = await client(origin);
  host.send({ type: "create", name: "host" });
  const { code } = await host.next("room");
  for (let i = 0; i < 5; i++) {
    const guest = await client(origin);
    guest.send({ type: "join", name: `guest${i}`, code });
    assert.equal((await guest.next("room")).members.length, i + 2);
  }
  const extra = await client(origin);
  extra.send({ type: "join", name: "extra", code });
  assert.match((await extra.next("error")).message, /已满/);
  extra.send({ type: "create", name: "other host" });
  await extra.next("room");
  extra.send({ type: "signal", to: host.id, signal: { kind: "offer", description: { type: "offer", sdp: "outside" } } });
  // An ordered response on the same socket acts as a barrier after the invalid signal.
  extra.send({ type: "study", status: "paused", elapsedMs: 0 });
  await extra.next("room", (m) => m.members[0].status === "paused");
  assert.equal(host.queue.some((m) => m.type === "signal"), false);
});

test("WebSocket rejects another website's origin", async (t) => {
  const { origin } = await start(t);
  const ws = new WebSocket(origin.replace("http", "ws") + "/room", { origin: "https://other.example" });
  const err = await new Promise((resolve) => ws.once("error", resolve));
  assert.match(err.message, /403/);
});
