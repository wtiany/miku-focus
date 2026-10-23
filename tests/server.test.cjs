"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const { createRoomServer } = require("../server.cjs");
const { tunnelUrl } = require("../tools/share.cjs");

async function start(t, options = {}) {
  const app = createRoomServer({ env: {}, ...options });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); t.after(() => app.close());
  return { ...app, origin: `http://127.0.0.1:${app.server.address().port}` };
}
async function client(origin, originHeader = origin) {
  const ws = new WebSocket(origin.replace("http", "ws") + "/room", { origin: originHeader });
  const queue = [], waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw), index = waiters.findIndex((w) => w.match(msg));
    if (index >= 0) { const [w] = waiters.splice(index, 1); clearTimeout(w.timer); w.resolve(msg); } else queue.push(msg);
  });
  function next(type, predicate = () => true) {
    const match = (msg) => msg.type === type && predicate(msg), index = queue.findIndex(match);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3000) }; waiters.push(waiter);
    });
  }
  const welcome = await next("welcome"); assert.equal(welcome.protocol, 2);
  return { ws, next, send: (msg) => ws.send(JSON.stringify(msg)), queue };
}
async function enter(origin, type = "create", code, name = type) {
  const c = await client(origin); c.send({ type, code, name }); const session = await c.next("session"); const room = await c.next("room");
  return { ...c, ...session, room };
}
async function upload(origin, member, name = "测试.wav", body = Buffer.from("RIFF-audio-data")) {
  return fetch(`${origin}/api/rooms/${member.code}/tracks`, { method: "POST", headers: { Origin: origin, Authorization: `Bearer ${member.token}`, "Content-Type": "audio/wav", "X-File-Name": encodeURIComponent(name), "X-Duration": "60" }, body });
}

test("public files/ranges work; private files and unauthenticated uploads are denied", async (t) => {
  const { origin } = await start(t);
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await (await fetch(origin + "/health")).json()).protocol, 2);
  for (const file of ["/.env", "/.git/config", "/server.cjs", "/.share-info.json", "/tools/share.cjs", "/assets/../server.cjs"]) assert.equal((await fetch(origin + file)).status, 404, file);
  const partial = await fetch(origin + "/assets/videos/miku_sea_color.mp4", { headers: { Range: "bytes=0-31" } });
  assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 32);
  assert.equal((await fetch(origin + "/assets/videos/miku_sea_color.mp4", { headers: { Range: "bytes=999999999-" } })).status, 416);
  assert.equal((await upload(origin, { code: "ABCDEF123456", token: "guess" })).status, 403);
});

test("any member can upload, play, seek, switch and remove; media URLs are private capabilities", async (t) => {
  const { origin } = await start(t);
  const host = await enter(origin), guest = await enter(origin, "join", host.code, "朋友");
  assert.equal((await upload(origin, guest)).status, 201);
  const added = await host.next("room", (m) => m.queue.length === 1);
  const track = added.queue[0]; assert.equal(track.addedBy, "朋友");
  const media = await fetch(origin + track.url, { headers: { Range: "bytes=0-3" } });
  assert.equal(media.status, 206); assert.equal(await media.text(), "RIFF"); assert.equal(media.headers.get("cache-control"), "private, no-store");
  assert.equal((await fetch(origin + track.url.replace(/key=.*/, "key=wrong"))).status, 404);
  guest.send({ type: "playback", action: "play" }); assert.equal((await host.next("room", (m) => m.playback.playing)).playback.trackId, track.id);
  guest.send({ type: "playback", action: "seek", position: 20 }); assert.ok((await host.next("room", (m) => m.playback.position >= 20)).playback.position < 21);
  guest.send({ type: "playback", action: "pause" }); await host.next("room", (m) => !m.playback.playing && m.playback.position >= 20);
  assert.equal((await upload(origin, host, "另一首.wav")).status, 201);
  const two = await guest.next("room", (m) => m.queue.length === 2);
  guest.send({ type: "playback", action: "next" }); await host.next("room", (m) => m.playback.trackId === two.queue[1].id);
  guest.send({ type: "remove-track", trackId: track.id }); await host.next("room", (m) => m.queue.length === 1);
  assert.equal((await fetch(origin + track.url)).status, 404);
  guest.send({ type: "study", status: "paused", elapsedMs: 1234 }); const study = await host.next("room", (m) => m.members.some((u) => u.id === guest.id && u.status === "paused"));
  assert.equal(study.playback.playing, true);
});

test("refresh resumes the same member; host leaves without ending room; only current host can close", async (t) => {
  const { origin } = await start(t, { hostGraceMs: 20 });
  const host = await enter(origin), guest = await enter(origin, "join", host.code);
  await upload(origin, host); const uploaded = await guest.next("room", (m) => m.queue.length === 1);
  host.ws.terminate(); await guest.next("room", (m) => m.hostId === guest.id);
  const resumed = await client(origin); resumed.send({ type: "resume", token: host.token, code: host.code });
  assert.equal((await resumed.next("session")).id, host.id);
  const restored = await resumed.next("room"); assert.equal(restored.members.length, 2); assert.equal(restored.queue[0].id, uploaded.queue[0].id);
  resumed.send({ type: "close-room" }); resumed.send({ type: "study", status: "study", elapsedMs: 0 });
  await resumed.next("room", (m) => m.members.some((u) => u.id === host.id && u.status === "study"));
  assert.equal(guest.queue.some((m) => m.type === "ended"), false);
  guest.send({ type: "leave" }); await guest.next("left"); await resumed.next("room", (m) => m.hostId === host.id && m.members.length === 1);
  resumed.send({ type: "close-room" }); await resumed.next("ended");
  assert.equal((await fetch(origin + uploaded.queue[0].url)).status, 404);
});

test("all-offline room can resume; expired room and cached media are cleared", async (t) => {
  const { origin, sweep } = await start(t, { roomTtlMs: 60 });
  const host = await enter(origin); await upload(origin, host); const added = await host.next("room", (m) => m.queue.length === 1);
  host.ws.terminate(); await new Promise((r) => setTimeout(r, 15));
  const resumed = await client(origin); resumed.send({ type: "resume", code: host.code, token: host.token }); await resumed.next("session"); await resumed.next("room");
  resumed.ws.terminate(); await new Promise((r) => setTimeout(r, 90)); sweep();
  const expired = await client(origin); expired.send({ type: "resume", code: host.code, token: host.token }); await expired.next("resume-expired");
  assert.equal((await fetch(origin + added.queue[0].url)).status, 404);
});

test("upload limits, six-member cap and cross-room authorization hold", async (t) => {
  const { origin } = await start(t, { maxFileBytes: 16, maxRoomBytes: 24 });
  const host = await enter(origin), other = await enter(origin);
  assert.equal((await upload(origin, { ...other, code: host.code })).status, 403);
  assert.equal((await upload(origin, host, "bad.exe")).status, 400);
  assert.equal((await upload(origin, host, "huge.wav", Buffer.alloc(17))).status, 413);
  assert.equal((await upload(origin, host)).status, 201);
  assert.equal((await upload(origin, host)).status, 413);
  for (let i = 0; i < 5; i++) await enter(origin, "join", host.code, `朋友${i}`);
  const extra = await client(origin); extra.send({ type: "join", code: host.code, name: "extra" }); assert.match((await extra.next("error")).message, /已满/);
  other.send({ type: "playback", action: "play" }); assert.match((await other.next("error")).message, /添加/);
});

test("automatic queue cycling does not keep an abandoned room alive", async (t) => {
  const { origin, sweep } = await start(t, { roomTtlMs: 150 });
  const host = await enter(origin);
  const response = await fetch(`${origin}/api/rooms/${host.code}/tracks`, { method: "POST", headers: { Origin: origin, Authorization: `Bearer ${host.token}`, "X-File-Name": "short.wav", "X-Duration": "0.1" }, body: Buffer.from("RIFF") });
  assert.equal(response.status, 201);
  const added = await host.next("room", (m) => m.queue.length === 1);
  host.send({ type: "playback", action: "play" }); await host.next("room", (m) => m.playback.playing);
  host.ws.terminate(); await new Promise((r) => setTimeout(r, 270)); sweep();
  assert.equal((await fetch(origin + added.queue[0].url)).status, 404);
});

test("public tunnel origin and localhost are both accepted; other origins are rejected", async (t) => {
  const { origin } = await start(t, { env: { PUBLIC_ORIGIN: "https://example.trycloudflare.com" } });
  const config = await (await fetch(origin + "/api/config")).json(); assert.equal(config.publicOrigin, "https://example.trycloudflare.com"); assert.equal(config.transport, "http");
  const publicClient = await client(origin, config.publicOrigin); publicClient.send({ type: "create", name: "public" }); await publicClient.next("session");
  await client(origin);
  const ws = new WebSocket(origin.replace("http", "ws") + "/room", { origin: "https://other.example" });
  assert.match((await new Promise((r) => ws.once("error", r))).message, /403/);
  assert.equal(tunnelUrl('INF Your URL: https://gentle-miku-focus.trycloudflare.com |'), "https://gentle-miku-focus.trycloudflare.com");
  assert.equal(tunnelUrl("https://trycloudflare.com.evil.test"), null);
});

test("NetEase import uses checked tracks, skips duplicates and shares a playable queue without storing files", async (t) => {
  const playlist = { id: "123", name: "公开歌单", total: 2, available: 1, tracks: [{ id: "111", name: "公开音乐", artist: "歌手", available: true, duration: 60 }, { id: "222", name: "不可播", available: false, duration: 60 }] };
  const netease = { getPlaylist: async () => playlist, resolveAudio: async () => "https://m10.music.126.net/public.mp3" };
  const { origin } = await start(t, { netease });
  const host = await enter(origin), guest = await enter(origin, "join", host.code, "朋友");
  const preview = await (await fetch(origin + "/api/netease/playlist?link=123")).json(); assert.equal(preview.available, 1);
  const post = (token) => fetch(`${origin}/api/rooms/${host.code}/netease`, { method: "POST", headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ playlistId: "123", url: "http://127.0.0.1/secret" }) });
  assert.equal((await post("wrong")).status, 403);
  assert.equal((await (await post(guest.token)).json()).added, 1);
  const room = await host.next("room", (m) => m.queue.some((t) => t.neteaseId === "111"));
  assert.equal(room.queue[0].source, "netease"); assert.equal(room.queue[0].url, "/api/netease/audio/111");
  assert.equal((await (await post(guest.token)).json()).added, 0);
  const audio = await fetch(origin + room.queue[0].url, { redirect: "manual" }); assert.equal(audio.status, 302); assert.equal(audio.headers.get("location"), "https://m10.music.126.net/public.mp3");
  guest.send({ type: "playback", action: "play" }); await host.next("room", (m) => m.playback.playing);
  guest.send({ type: "remove-track", trackId: room.queue[0].id }); await host.next("room", (m) => !m.queue.length);
});
