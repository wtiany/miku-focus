"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
const { WebSocketServer, WebSocket } = require("ws");
const { createNeteaseProvider } = require("./netease.cjs");
const { createNeteaseAuth } = require("./netease-auth.cjs");
const { createCredentialStore } = require("./credential-store.cjs");
const { createBackgroundStore } = require("./background-store.cjs");

const ROOT = __dirname;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".png":"image/png", ".webp":"image/webp", ".gif":"image/gif", ".mp4": "video/mp4" };
const AUDIO = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".webm": "audio/webm" };
const PUBLIC = new Set(["style.css", "app.js", "personal-data.js", "music-library.js", "room.css", "room.js", "netease.js", "assets/images/custom-backgrounds.js"]);
const STATES = new Set(["idle", "study", "paused", "break"]);
const cleanName = (s) => typeof s === "string" ? s.trim().slice(0, 24) : "";

function createRoomServer(options = {}) {
  const env = options.env || process.env;
  const netease = options.netease || createNeteaseProvider();
  const backgroundDirectory=options.backgroundDirectory || path.join(ROOT,"assets/images");
  const backgrounds=createBackgroundStore({directory:backgroundDirectory}), backgroundToken=randomBytes(32).toString("hex");
  function localBackgroundAccess(req) {
    if(req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"] || req.headers.forwarded || req.headers["sec-fetch-site"]==="cross-site") return false;
    const peer=req.socket.remoteAddress, own=req.socket.localAddress;
    let host;try {host=new URL("http://"+req.headers.host).hostname;} catch {return false;}
    return (["127.0.0.1","::1","::ffff:127.0.0.1"].includes(peer) && ["localhost","127.0.0.1","[::1]"].includes(host)) || (peer===own && [own,`[${own}]`].includes(host));
  }
  const authStore = options.authStore !== undefined ? options.authStore : createCredentialStore();
  const neteaseAuth = createNeteaseAuth({ store: authStore, fetch: options.authFetch, publicProvider: netease, diagnostic: options.authDiagnostic || (options.env ? null : (data) => console.info('[netease-auth]', JSON.stringify(data))) });
  async function musicContext(req) {
    const session = neteaseAuth.find(req); await neteaseAuth.refresh(session); const epoch = session?.epoch;
    return { provider: neteaseAuth.provider(req), check() { if (session && session.epoch !== epoch) throw Object.assign(new Error("登录状态已改变，请重新读取歌单。"), { status: 401 }); } };
  }
  const rooms = new Map(), connections = new Set(), sessions = new Map();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "miku-room-"));
  const maxFileBytes = options.maxFileBytes || 50 * 1024 * 1024;
  const maxRoomBytes = options.maxRoomBytes || 300 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes || 1024 * 1024 * 1024;
  const roomTtlMs = options.roomTtlMs || 30 * 60000;
  const reconnectMs = options.reconnectMs || 2 * 60000;
  const hostGraceMs = options.hostGraceMs ?? 10000;
  let totalBytes = 0, reservedBytes = 0, closing = false;
  const uploads = new Set();
  const send = (ws, data) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) { ws.terminate(); return; }
    ws.send(JSON.stringify(data));
  };
  const error = (ws, message) => send(ws, { type: "error", message });
  const position = (room, now = Date.now()) => {
    const p = room.playback;
    const track = room.queue.find((t) => t.id === p.trackId);
    const value = p.position + (p.playing ? Math.max(0, now - p.updatedAt) / 1000 : 0);
    return track?.duration ? Math.min(value, track.duration) : value;
  };
  const publicOrigin = () => {
    try { const u = new URL(env.PUBLIC_ORIGIN); return u.protocol === "https:" ? u.origin : null; } catch { return null; }
  };
  function allowedOrigin(req) {
    try {
      const origin = new URL(req.headers.origin);
      if (!["http:", "https:"].includes(origin.protocol)) return false;
      if (origin.origin === publicOrigin()) return true;
      // The share launcher keeps local access working after its public URL is ready.
      if (publicOrigin()) return ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && origin.port === String(server.address()?.port);
      return origin.host === req.headers.host;
    } catch { return false; }
  }
  function broadcast(room) {
    const now = Date.now();
    const data = {
      type: "room", code: room.code, hostId: room.hostId, serverNow: now,
      members: [...room.members.values()].map((m) => ({
        id: m.id, name: m.name, online: Boolean(m.ws), ...m.study,
        elapsedMs: m.study.elapsedMs + (m.study.status === "study" ? Math.max(0, now - m.study.updatedAt) : 0),
      })),
      queue: room.queue.map((t) => ({ id: t.id, name: t.name, artist: t.artist, source: t.source, neteaseId: t.neteaseId, requiresLogin: t.requiresLogin, duration: t.duration, addedBy: t.addedBy, url: t.url || `/media/${room.code}/${t.id}?key=${t.key}` })),
      playback: { ...room.playback, position: position(room, now), updatedAt: now },
    };
    for (const m of room.members.values()) send(m.ws, data);
  }
  function scheduleTrack(room) {
    clearTimeout(room.trackTimer);
    const track = room.queue.find((t) => t.id === room.playback.trackId);
    if (!room.playback.playing || !track?.duration) return;
    room.trackTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room) return;
      const index = room.queue.findIndex((t) => t.id === room.playback.trackId);
      setPlayback(room, room.queue[(index + 1) % room.queue.length]?.id, true, 0, false);
      broadcast(room);
    }, Math.max(100, (track.duration - position(room)) * 1000));
    room.trackTimer.unref();
  }
  function setPlayback(room, trackId, playing, at = 0, touch = true) {
    const track = room.queue.find((t) => t.id === trackId);
    room.playback = { trackId: track?.id || null, playing: Boolean(track && playing), position: Math.max(0, Math.min(at, track?.duration || 43200)), updatedAt: Date.now(), version: room.playback.version + 1 };
    if (touch) room.lastActivity = Date.now();
    scheduleTrack(room);
  }
  function electHost(room) {
    clearTimeout(room.hostTimer);
    room.hostId = [...room.members.values()].find((m) => m.ws)?.id || room.members.keys().next().value || null;
  }
  function deleteFile(file) { return file ? fsp.unlink(file).catch(() => {}) : Promise.resolve(); }
  function destroyRoom(room, reason = "房间已结束。个人计时会继续。") {
    clearTimeout(room.trackTimer); clearTimeout(room.hostTimer);
    rooms.delete(room.code);
    for (const m of room.members.values()) {
      sessions.delete(m.token);
      if (m.connection) m.connection.member = null;
      send(m.ws, { type: "ended", message: reason });
    }
    for (const t of room.queue) { totalBytes -= t.bytes; deleteFile(t.file); }
    room.members.clear(); room.queue = [];
  }
  function leave(connection, explicit = false) {
    const member = connection.member;
    connection.member = null;
    if (!member || member.connection !== connection) return;
    const room = rooms.get(member.code);
    if (!room) return;
    member.ws = null; member.connection = null; member.lastSeen = Date.now();
    room.lastActivity = Date.now();
    if (explicit) {
      sessions.delete(member.token); room.members.delete(member.id);
      if (!room.members.size) { destroyRoom(room); return; }
      if (room.hostId === member.id) electHost(room);
    } else if (room.hostId === member.id) {
      room.hostTimer = setTimeout(() => {
        if (rooms.get(room.code) === room && !room.members.get(room.hostId)?.ws) { electHost(room); broadcast(room); }
      }, hostGraceMs);
      room.hostTimer.unref();
    }
    broadcast(room);
  }
  function sweep() {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (![...room.members.values()].some((m) => m.ws)) {
        if (now - room.lastActivity > roomTtlMs) destroyRoom(room, "房间长时间无人在线，已自动清理。");
        continue;
      }
      let changed = false;
      for (const m of room.members.values()) if (!m.ws && now - m.lastSeen > reconnectMs) {
        sessions.delete(m.token); room.members.delete(m.id); changed = true;
      }
      if (!room.members.has(room.hostId)) electHost(room);
      if (changed) broadcast(room);
    }
  }
  function json(res, code, body) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body));
  }
  async function serveFile(req, res, file, mime, privateFile = false) {
    let stat;
    try { stat = await fsp.stat(file); } catch { res.writeHead(404).end(); return; }
    if (!stat.isFile()) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", privateFile ? "private, no-store" : file.startsWith(path.join(ROOT, "assets")) && mime!==MIME[".js"] ? "public, max-age=3600" : "no-cache");
    res.setHeader("Accept-Ranges", "bytes");
    let start = 0, end = stat.size - 1;
    if (req.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!m || (!m[1] && !m[2])) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end(); return; }
      if (!m[1]) start = Math.max(0, stat.size - Number(m[2]));
      else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end(); return; }
      res.statusCode = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    }
    res.setHeader("Content-Length", end - start + 1);
    if (req.method === "HEAD") { res.end(); return; }
    const stream = fs.createReadStream(file, { start, end });
    stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res);
  }
  async function upload(req, res, code) {
    const member = sessions.get((req.headers.authorization || "").replace(/^Bearer /, ""));
    const room = rooms.get(code);
    if (!allowedOrigin(req) || !room || !member || member.code !== code || !member.ws) { json(res, 403, { error: "请先加入房间。" }); return; }
    let name;
    try { name = decodeURIComponent(req.headers["x-file-name"] || "").replace(/[\\/\u0000-\u001f]/g, "").slice(0, 180); } catch { json(res, 400, { error: "文件名无效。" }); return; }
    const mime = AUDIO[path.extname(name).toLowerCase()];
    const bytes = Number(req.headers["content-length"]);
    const duration = Number(req.headers["x-duration"]);
    if (!mime || !Number.isFinite(duration) || duration <= 0 || duration > 43200) { json(res, 400, { error: "请选择可播放的音频文件。" }); return; }
    if (!Number.isSafeInteger(bytes) || bytes <= 0) { json(res, 411, { error: "无法读取音频大小。" }); return; }
    if (bytes > maxFileBytes || room.bytes + room.reserved + bytes > maxRoomBytes || totalBytes + reservedBytes + bytes > maxTotalBytes) { json(res, 413, { error: "单曲最多 50 MB，房间总共最多 300 MB，或服务空间已满。" }); return; }
    if (room.queue.filter((t) => t.file).length + room.uploading >= 30 || room.queue.length + room.uploading >= 200 || member.uploading) { json(res, 429, { error: "本地音乐最多 30 首，总歌单最多 200 首；请等待当前上传完成。" }); return; }
    const id = randomUUID(), file = path.join(dataDir, id);
    member.uploading = true; room.uploading++; room.reserved += bytes; reservedBytes += bytes;
    const operation = (async () => {
      try {
        let received = 0;
        await pipeline(req, new Transform({ transform(chunk, encoding, callback) { received += chunk.length; callback(received > bytes ? new Error("Upload too large") : null, chunk); } }), fs.createWriteStream(file, { flags: "wx" }));
        if (received !== bytes || closing || rooms.get(code) !== room || !sessions.has(member.token)) throw new Error("Room no longer available");
        const track = { id, file, mime, bytes, duration, key: randomBytes(24).toString("hex"), name: name.replace(/\.[^.]+$/, ""), addedBy: member.name };
        room.queue.push(track); room.bytes += bytes; totalBytes += bytes; room.lastActivity = Date.now();
        if (!room.playback.trackId) setPlayback(room, id, false, 0);
        broadcast(room); json(res, 201, { id });
      } catch {
        await deleteFile(file);
        if (!res.destroyed) json(res, 400, { error: "上传中断或房间已结束，请重试。" });
      } finally { member.uploading = false; room.uploading--; room.reserved -= bytes; reservedBytes -= bytes; }
    })();
    uploads.add(operation); operation.finally(() => uploads.delete(operation));
    await operation;
  }
  const server = http.createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: "服务暂时无法处理请求。" }); else res.destroy(); });
  });
  server.requestTimeout = 120000;
  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { res.writeHead(400).end(); return; }
    if(url.pathname==="/api/backgrounds") {
      if(req.method==="GET") {const canUpload=localBackgroundAccess(req);json(res,200,{items:await backgrounds.list(),canUpload,...(canUpload?{token:backgroundToken}:{})});return;}
      if(req.method!=="POST") {res.writeHead(405).end();return;}
      if(!localBackgroundAccess(req) || !allowedOrigin(req) || req.headers["x-background-token"]!==backgroundToken) {json(res,403,{error:"复制背景到项目需要在运行服务的电脑上操作，请刷新本机页面后重试。"});return;}
      try {
        const parts=[];let length=0;
        for await(const part of req) {length+=part.length;if(length>20*1024*1024) throw Object.assign(new Error("每张背景图片最多 20 MB。"),{status:413});parts.push(part);}
        let name="自选背景";try {name=decodeURIComponent(String(req.headers["x-file-name"] || "自选背景").slice(0,1500));} catch {}
        json(res,201,await backgrounds.save(Buffer.concat(parts),name));
      } catch(err) {json(res,err.status || 500,{error:err.status?err.message:"未能保存背景图片，请检查项目文件夹是否可写。"});}
      return;
    }
    if (url.pathname.startsWith("/api/netease/auth/")) {
      if (req.headers["sec-fetch-site"] === "cross-site") { json(res, 403, { error: "请在学习页面中操作登录。" }); return; }
      try {
        const secure = req.headers["x-forwarded-proto"] === "https" || Boolean(req.socket.encrypted);
        if (url.pathname === "/api/netease/auth/status" && req.method === "GET") {
          const account = neteaseAuth.ensure(req, res, secure); await neteaseAuth.refresh(account); neteaseAuth.writeCookie(account,res,secure);
          json(res, 200, neteaseAuth.status(account)); return;
        }
        const account = neteaseAuth.find(req);
        if (req.method !== "POST" || !allowedOrigin(req) || !account || req.headers["x-csrf-token"] !== account.csrf) { json(res, 403, { error: "登录操作验证失败，请刷新页面后重试。" }); return; }
        let result;
        if (["/api/netease/auth/qr", "/api/netease/auth/remember"].includes(url.pathname)) {
          let body="";for await(const chunk of req) {body+=chunk.toString();if(body.length>256) throw Object.assign(new Error("请求过大。"),{status:413});}
          let input;try {input=JSON.parse(body || "{}");} catch {throw Object.assign(new Error("登录请求无效。"),{status:400});}
          if(url.pathname.endsWith("/remember") && typeof input?.remember!=="boolean") throw Object.assign(new Error("请选择是否记住登录。"),{status:400});
          result=url.pathname.endsWith("/qr") ? await neteaseAuth.startQr(account,input?.remember===true) : await neteaseAuth.remember(account,input.remember);
        }
        else if (url.pathname === "/api/netease/auth/check") result=await neteaseAuth.checkQr(account, url.searchParams.get("challenge"));
        else if (url.pathname === "/api/netease/auth/logout") {result=neteaseAuth.logout(account);await neteaseAuth.flush();}
        else {json(res, 404, { error: "登录接口不存在。" });return;}
        neteaseAuth.writeCookie(account,res,secure);json(res,200,result);
      } catch (err) { json(res, err.status || 502, { error: err.status ? err.message : "网易云登录服务暂时无法连接，请稍后重试。" }); }
      return;
    }
    const neteaseImport = /^\/api\/rooms\/([A-F0-9]{12})\/netease$/.exec(url.pathname);
    if (req.method === "POST" && neteaseImport) {
      const member = sessions.get((req.headers.authorization || "").replace(/^Bearer /, ""));
      const room = rooms.get(neteaseImport[1]);
      if (!allowedOrigin(req) || !room || !member || member.code !== room.code || !member.ws) { json(res, 403, { error: "请先加入房间。" }); return; }
      if (Number(req.headers["content-length"]) > 2048) { json(res, 413, { error: "请求过大。" }); return; }
      try {
        let body = "";
        for await (const chunk of req) { body += chunk.toString(); if (body.length > 2048) throw Object.assign(new Error("请求过大。"), { status: 413 }); }
        let input; try { input = JSON.parse(body); } catch { json(res, 400, { error: "导入请求无效。" }); return; }
        const context = await musicContext(req);
        const playlist = await context.provider.getPlaylist(input.playlistId); context.check();
        if (rooms.get(room.code) !== room || !sessions.has(member.token)) { json(res, 409, { error: "你已离开房间，请重新加入。" }); return; }
        const existing = new Set(room.queue.map((t) => t.neteaseId));
        const available = playlist.tracks.filter((t) => t.available && !existing.has(t.id));
        const selected = available.slice(0, Math.max(0, 200 - room.queue.length - room.uploading));
        for (const t of selected) room.queue.push({ id: randomUUID(), source: "netease", neteaseId: t.id, requiresLogin: Boolean(t.requiresLogin), url: `/api/netease/audio/${t.id}`, name: t.name, artist: t.artist, duration: t.duration, addedBy: member.name, bytes: 0 });
        if (!room.playback.trackId && room.queue.length) setPlayback(room, room.queue[0].id, false, 0);
        room.lastActivity = Date.now(); broadcast(room);
        json(res, 200, { added: selected.length, skipped: playlist.tracks.length - selected.length, capacitySkipped: available.length - selected.length });
      } catch (err) { json(res, err.status || 502, { error: err.status ? err.message : "暂时无法导入网易云歌单。" }); }
      return;
    }
    const uploadMatch = /^\/api\/rooms\/([A-F0-9]{12})\/tracks$/.exec(url.pathname);
    if (req.method === "POST" && uploadMatch) { await upload(req, res, uploadMatch[1]); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    if (url.pathname === "/api/netease/playlist") {
      try { const link = url.searchParams.get("link") || ""; if (link.length > 1000) { json(res, 400, { error: "链接过长，请只粘贴歌单链接。" }); return; } const context = await musicContext(req); const data = await context.provider.getPlaylist(link); context.check(); json(res, 200, data); }
      catch (err) { json(res, err.status || 502, { error: err.status ? err.message : "连接网易云失败，请稍后重试。" }); }
      return;
    }
    const neteaseAudio = /^\/api\/netease\/audio\/([1-9]\d{0,15})$/.exec(url.pathname);
    if (neteaseAudio) {
      try { const context = await musicContext(req); const target = await context.provider.resolveAudio(neteaseAudio[1]); context.check(); res.writeHead(302, { Location: target, "Cache-Control": "no-store" }); res.end(); }
      catch (err) { json(res, err.status || 502, { error: err.status ? err.message : "无法加载网易云音频。" }); }
      return;
    }
    if (url.pathname === "/health") { json(res, 200, { ok: true, service: "miku-focus-room", protocol: 2 }); return; }
    if (url.pathname === "/api/config") { json(res, 200, { publicOrigin: publicOrigin(), transport: "http", maxFileBytes, roomTtlMs }); return; }
    const media = /^\/media\/([A-F0-9]{12})\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (media) {
      const track = rooms.get(media[1])?.queue.find((t) => t.id === media[2]);
      if (!track || track.key !== url.searchParams.get("key")) { res.writeHead(404).end(); return; }
      await serveFile(req, res, track.file, track.mime, true); return;
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    if (pathname === "/" || pathname === "/index.html") {
      await serveFile(req, res, path.join(ROOT, "..", "index.html"), MIME[".html"]); return;
    }
    // Only the same public assets are exposed; app/ also contains private server files.
    const relative = pathname.startsWith("/app/") ? pathname.slice(5) : pathname.slice(1);
    const asset = /^(?:assets\/images\/[a-zA-Z0-9_-]+\.(jpg|png|webp|gif)|assets\/videos\/[a-zA-Z0-9_-]+\.mp4)$/.test(relative);
    if (!PUBLIC.has(relative) && !asset) { res.writeHead(404).end(); return; }
    if (relative === "assets/images/custom-backgrounds.js" && !(await fsp.stat(path.join(backgroundDirectory, "custom-backgrounds.js")).catch(() => null))) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end("globalThis.MikuCustomBackgrounds = [];\n"); return;
    }
    const custom=relative==="assets/images/custom-backgrounds.js" || /^assets\/images\/custom-[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(relative);
    await serveFile(req, res, custom?path.join(backgroundDirectory,path.basename(relative)):path.join(ROOT, relative), MIME[path.extname(relative)] || "application/octet-stream");
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    if (!allowedOrigin(req) || req.url !== "/room" || connections.size >= 600) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    const connection = { ws, member: null, alive: true, messages: 0, windowStart: Date.now(), attempts: 0, attemptWindow: Date.now() };
    connections.add(connection);
    send(ws, { type: "welcome", protocol: 2, serverNow: Date.now() });
    ws.on("pong", () => { connection.alive = true; }); ws.on("error", () => {});
    ws.on("close", () => { connections.delete(connection); if (!closing) leave(connection); });
    ws.on("message", (raw, binary) => {
      if (Date.now() - connection.windowStart > 10000) { connection.windowStart = Date.now(); connection.messages = 0; }
      if (binary || ++connection.messages > 200) { ws.close(1008, "Message limit"); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { error(ws, "无法识别的房间消息。"); return; }
      if (!msg || typeof msg !== "object") return;
      if (["create", "join", "resume"].includes(msg.type)) {
        if (Date.now() - connection.attemptWindow > 60000) { connection.attemptWindow = Date.now(); connection.attempts = 0; }
        if (++connection.attempts > 10) { error(ws, "尝试过于频繁，请稍后再试。"); return; }
        if (connection.member) { error(ws, "请先离开当前房间。"); return; }
        let room, member;
        if (msg.type === "resume") {
          member = sessions.get(msg.token);
          room = member && rooms.get(member.code);
          if (!room || room.code !== msg.code) { send(ws, { type: "resume-expired", message: "上次的房间已过期，请重新加入。" }); return; }
        } else {
          const name = cleanName(msg.name);
          if (!name) { error(ws, "请先填写昵称。"); return; }
          if (msg.type === "create") {
            if (rooms.size >= 100) { error(ws, "房间已满，请稍后再试。"); return; }
            let code; do { code = randomBytes(6).toString("hex").toUpperCase(); } while (rooms.has(code));
            room = { code, hostId: null, members: new Map(), queue: [], bytes: 0, reserved: 0, uploading: 0, lastActivity: Date.now(), playback: { trackId: null, playing: false, position: 0, updatedAt: Date.now(), version: 0 } };
            rooms.set(code, room);
          } else {
            sweep();
            room = rooms.get(typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "");
            if (!room) { error(ws, "房间不存在或已过期，请检查邀请链接。"); return; }
            if (room.members.size >= 6) { error(ws, "房间已满，最多 6 人。断线席位会保留两分钟。"); return; }
          }
          member = { id: randomUUID(), token: randomBytes(32).toString("hex"), name, code: room.code, study: { status: "idle", elapsedMs: 0, updatedAt: Date.now() }, lastSeen: Date.now(), ws: null, connection: null };
          room.members.set(member.id, member); sessions.set(member.token, member);
        }
        const oldWs = member.ws;
        member.ws = ws; member.connection = connection; member.lastSeen = Date.now(); connection.member = member;
        if (oldWs && oldWs !== ws) oldWs.close(1000, "Session resumed elsewhere");
        if (!room.hostId) room.hostId = member.id;
        if (room.hostId === member.id) clearTimeout(room.hostTimer);
        room.lastActivity = Date.now();
        send(ws, { type: "session", id: member.id, code: room.code, token: member.token, name: member.name });
        broadcast(room); return;
      }
      if (msg.type === "ping") { send(ws, { type: "pong", clientTime: msg.clientTime, serverNow: Date.now() }); return; }
      const member = connection.member, room = member && rooms.get(member.code);
      if (!room) return;
      room.lastActivity = Date.now();
      if (msg.type === "leave") { leave(connection, true); send(ws, { type: "left" }); return; }
      if (msg.type === "close-room" && room.hostId === member.id) { destroyRoom(room); return; }
      if (msg.type === "study") {
        if (!STATES.has(msg.status) || !Number.isFinite(msg.elapsedMs) || msg.elapsedMs < 0 || msg.elapsedMs > 366 * 86400000) return;
        member.study = { status: msg.status, elapsedMs: msg.elapsedMs, updatedAt: Date.now() }; broadcast(room);
      } else if (msg.type === "playback") {
        const index = room.queue.findIndex((t) => t.id === room.playback.trackId);
        if (index < 0) { error(ws, "先添加一首音乐吧。"); return; }
        const current = room.queue[index];
        if (msg.action === "play") setPlayback(room, current.id, true, position(room) >= current.duration ? 0 : position(room));
        else if (msg.action === "pause") setPlayback(room, current.id, false, position(room));
        else if (msg.action === "next" || msg.action === "prev") setPlayback(room, room.queue[(index + (msg.action === "next" ? 1 : room.queue.length - 1)) % room.queue.length].id, true, 0);
        else if (msg.action === "select" && room.queue.some((t) => t.id === msg.trackId)) setPlayback(room, msg.trackId, true, 0);
        else if (msg.action === "seek" && Number.isFinite(msg.position) && msg.position >= 0) setPlayback(room, current.id, room.playback.playing, msg.position);
        else return;
        broadcast(room);
      } else if (msg.type === "remove-track") {
        const index = room.queue.findIndex((t) => t.id === msg.trackId);
        if (index < 0) return;
        const [track] = room.queue.splice(index, 1);
        room.bytes -= track.bytes; totalBytes -= track.bytes; deleteFile(track.file);
        if (room.playback.trackId === track.id) setPlayback(room, room.queue[index % room.queue.length]?.id, room.playback.playing, 0);
        broadcast(room);
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const c of connections) { if (!c.alive) c.ws.terminate(); else { c.alive = false; c.ws.ping(); } }
    sweep();
  }, 30000);
  heartbeat.unref();
  async function close() {
    await backgrounds.flush();
    await neteaseAuth.close();
    closing = true; clearInterval(heartbeat);
    for (const room of [...rooms.values()]) destroyRoom(room);
    for (const c of connections) c.ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...uploads]);
    // This folder was uniquely created above; remove only its own files, never a parent directory.
    for (const name of await fsp.readdir(dataDir)) await deleteFile(path.join(dataDir, name));
    await fsp.rmdir(dataDir);
  }
  return { server, close, sweep };
}
if (require.main === module) {
  const app = createRoomServer();
  app.server.listen(Number(process.env.PORT || 8642), process.env.HOST || "127.0.0.1", () => {
    const address = app.server.address();
    const hostname = ["0.0.0.0", "::", "127.0.0.1", "::1"].includes(address.address) ? "localhost" : address.address.includes(":") ? `[${address.address}]` : address.address;
    const url = `http://${hostname}:${address.port}`;
    console.log(`Miku Focus: ${url}\nFor a public HTTPS link, run npm run share.`);
    if (process.env.MIKU_OPEN_BROWSER === "1") {
      const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      const opener = spawn(command, [url], { windowsHide: true, stdio: "ignore" });
      opener.on("error", () => console.warn(`Please open ${url} in your browser.`)); opener.unref();
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close().then(() => process.exit(0)));
}
module.exports = { createRoomServer };
