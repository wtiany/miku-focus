"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, createHmac } = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

const ROOT = __dirname;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".mp4": "video/mp4" };
const PUBLIC = new Set(["index.html", "style.css", "app.js", "room.css", "room.js"]);
const STATES = new Set(["idle", "study", "paused", "break"]);
const cleanName = (s) => typeof s === "string" ? s.trim().slice(0, 24) : "";

function createRoomServer(options = {}) {
  const env = options.env || process.env;
  const rooms = new Map();
  const clients = new Map();
  const maxRooms = 100;
  const maxMembers = 6;
  const send = (ws, data) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) { ws.terminate(); return; }
    ws.send(JSON.stringify(data));
  };
  const error = (ws, message) => send(ws, { type: "error", message });

  function iceServers(id) {
    const result = [];
    const stun = env.STUN_URL ?? "stun:stun.l.google.com:19302";
    if (stun) result.push({ urls: stun });
    if (env.TURN_URLS) {
      const urls = env.TURN_URLS.split(",").map((s) => s.trim()).filter(Boolean);
      if (env.TURN_SHARED_SECRET) {
        const username = `${Math.floor(Date.now() / 1000) + 86400}:${id}`;
        result.push({ urls, username, credential: createHmac("sha1", env.TURN_SHARED_SECRET).update(username).digest("base64") });
      } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
        result.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
      }
    }
    return result;
  }

  function broadcast(room) {
    const now = Date.now();
    const members = [...room.members.values()].map((c) => ({
      id: c.id, name: c.name, ...c.study,
      elapsedMs: c.study.elapsedMs + (c.study.status === "study" ? Math.max(0, now - c.study.updatedAt) : 0),
    }));
    for (const c of room.members.values()) send(c.ws, {
      type: "room", code: room.code, hostId: room.hostId, members, track: room.track,
    });
  }

  function leave(client) {
    const room = rooms.get(client.code);
    client.code = null;
    if (!room) return;
    room.members.delete(client.id);
    if (client.id === room.hostId) {
      for (const c of room.members.values()) {
        c.code = null;
        send(c.ws, { type: "ended", message: "房主已离开，房间已结束。你的个人计时会继续。" });
      }
      rooms.delete(room.code);
    } else broadcast(room);
  }

  const server = http.createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
    catch { res.writeHead(400).end(); return; }
    if (pathname === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true })); return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    // Explicit public files only: never expose .env, .git, imported music, or ZIP archives.
    const asset = /^assets\/(images|videos)\/[a-zA-Z0-9_-]+\.(jpg|mp4)$/.test(relative);
    if (!PUBLIC.has(relative) && !asset) { res.writeHead(404).end(); return; }
    const file = path.join(ROOT, relative);
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404).end(); return; }
      res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
      res.setHeader("Cache-Control", asset ? "public, max-age=3600" : "no-cache");
      res.setHeader("Accept-Ranges", "bytes");
      let start = 0, end = stat.size - 1;
      if (req.headers.range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!m || (!m[1] && !m[2])) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end(); return; }
        if (!m[1]) start = Math.max(0, stat.size - Number(m[2]));
        else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
        if (start > end || start >= stat.size) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end(); return; }
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader("Content-Length", end - start + 1);
      if (req.method === "HEAD") { res.end(); return; }
      const stream = fs.createReadStream(file, { start, end });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    let accepted = false;
    try {
      const origin = new URL(req.headers.origin);
      const allowed = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : `${origin.protocol}//${req.headers.host}`;
      accepted = ["http:", "https:"].includes(origin.protocol) && origin.origin === allowed && req.url === "/room";
    } catch {}
    if (!accepted || clients.size >= 600) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const client = { id: randomUUID(), ws, code: null, name: "", study: { status: "idle", elapsedMs: 0, updatedAt: Date.now() }, alive: true, messages: 0, windowStart: Date.now(), attempts: 0, attemptWindow: Date.now() };
    clients.set(client.id, client);
    send(ws, { type: "welcome", id: client.id, iceServers: iceServers(client.id), hasTurn: Boolean(env.TURN_URLS && (env.TURN_SHARED_SECRET || env.TURN_USERNAME && env.TURN_CREDENTIAL)) });
    ws.on("pong", () => { client.alive = true; });
    ws.on("error", () => {});
    ws.on("close", () => { leave(client); clients.delete(client.id); });
    ws.on("message", (raw, binary) => {
      if (Date.now() - client.windowStart > 10000) { client.windowStart = Date.now(); client.messages = 0; }
      if (binary || ++client.messages > 200) { ws.close(1008, "Message limit"); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { error(ws, "无法识别的房间消息。"); return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "create" || msg.type === "join") {
        if (Date.now() - client.attemptWindow > 60000) { client.attemptWindow = Date.now(); client.attempts = 0; }
        if (++client.attempts > 10) { error(ws, "尝试过于频繁，请稍后再试。"); return; }
        if (client.code) { error(ws, "请先离开当前房间。"); return; }
        const name = cleanName(msg.name);
        if (!name) { error(ws, "请先填写昵称。"); return; }
        let room;
        if (msg.type === "create") {
          if (rooms.size >= maxRooms) { error(ws, "房间已满，请稍后再试。"); return; }
          let code;
          do { code = randomBytes(6).toString("hex").toUpperCase(); } while (rooms.has(code));
          room = { code, hostId: client.id, members: new Map(), track: { name: "房主还没有播放音乐", playing: false } };
          rooms.set(code, room);
        } else {
          room = rooms.get(typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "");
          if (!room) { error(ws, "房间不存在或已结束，请检查房间码。"); return; }
          if (room.members.size >= maxMembers) { error(ws, "房间已满，最多 6 人。"); return; }
        }
        client.name = name; client.code = room.code;
        room.members.set(client.id, client);
        broadcast(room); return;
      }
      if (msg.type === "leave") { leave(client); send(ws, { type: "left" }); return; }
      const room = rooms.get(client.code);
      if (!room) return;
      if (msg.type === "study") {
        if (!STATES.has(msg.status) || !Number.isFinite(msg.elapsedMs) || msg.elapsedMs < 0 || msg.elapsedMs > 366 * 86400000) return;
        client.study = { status: msg.status, elapsedMs: msg.elapsedMs, updatedAt: Date.now() };
        broadcast(room);
      } else if (msg.type === "track" && client.id === room.hostId) {
        room.track = { name: typeof msg.name === "string" ? msg.name.slice(0, 180) : "", playing: msg.playing === true };
        broadcast(room);
      } else if (msg.type === "signal") {
        const target = room.members.get(msg.to);
        // Only host <-> guest signaling; no cross-room or guest-to-guest messages.
        if (!target || target.id === client.id || (client.id !== room.hostId && target.id !== room.hostId)) return;
        const signal = msg.signal;
        if (!signal || !["offer", "answer", "ice", "ready"].includes(signal.kind)) return;
        if ((signal.kind === "offer" && client.id !== room.hostId) || (["answer", "ready"].includes(signal.kind) && client.id === room.hostId)) return;
        send(target.ws, { type: "signal", from: client.id, signal });
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false; c.ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  async function close() {
    clearInterval(heartbeat);
    for (const c of clients.values()) c.ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  return { server, close };
}

if (require.main === module) {
  const app = createRoomServer();
  app.server.listen(Number(process.env.PORT || 8642), process.env.HOST || "127.0.0.1", () => {
    console.log(`Miku Focus: http://localhost:${app.server.address().port}`);
    if (!process.env.TURN_URLS) console.log("TURN is not configured. Remote connectivity is not guaranteed.");
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close().then(() => process.exit(0)));
}
module.exports = { createRoomServer };
