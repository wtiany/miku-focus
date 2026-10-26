/* Shared room: same-origin HTTP music, shared queue and resumable membership. */
(() => {
  "use strict";
  const el = (id) => document.getElementById(id);
  const audio = el("roomAudio"), panel = el("roomPanel");
  const SESSION_KEY = "mikuFocusRoom_v2";
  const statusNames = { idle: "准备中", study: "专注中", paused: "已暂停", break: "休息中" };
  const playIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 5v14M15 5v14"/></svg>';
  let socket = null, room = null, session = null, busy = false, listening = true;
  let reconnectTimer = 0, retry = 0, serverOffset = 0, bestRtt = Infinity, currentTrack = null;
  let publicUrl = null, online = false, uploading = false, uploadAbort = null;
  let renderedQueue = "", recovering = false, pendingControl = null, controlTimer = 0;
  function clearControl() { pendingControl = null; clearTimeout(controlTimer); }
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch {}
  try { el("roomName").value = localStorage.getItem("mikuFocusNickname") || ""; } catch {}
  function message(text, isError = false) { el("roomMessage").textContent = text; el("roomMessage").dataset.error = String(isError); }
  function openPanel(open) { panel.hidden = !open; el("roomLaunch").setAttribute("aria-expanded", String(open)); }
  function storeSession() { try { if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); else sessionStorage.removeItem(SESSION_KEY); } catch {} }
  function busyState(value) { busy = value; for (const id of ["roomCreate", "roomJoin", "roomName", "roomCode"]) el(id).disabled = value; }
  function send(data) {
    if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(data)); return true; }
    message("连接正在恢复，请稍候…", true); return false;
  }
  function resetRoom(text) {
    clearTimeout(reconnectTimer); clearControl();
    const oldSocket = socket; socket = null; room = null; session = null; online = false;
    storeSession(); retry = 0; currentTrack = null; renderedQueue = ""; recovering = false;
    uploadAbort?.abort(); audio.pause(); audio.removeAttribute("src"); audio.load();
    if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) oldSocket.close();
    el("roomActive").hidden = true; el("roomLobby").hidden = false; el("roomDot").hidden = true;
    el("roomLaunchLabel").textContent = "一起学习"; el("roomMembers").replaceChildren();
    el("btnMode").disabled = false; document.body.classList.remove("room-connected");
    for (const id of ["btnPlay", "btnPrev", "btnNext"]) el(id).disabled = false;
    el("playlist").classList.remove("open"); el("btnPlay").title = "播放 / 暂停";
    busyState(false); window.dispatchEvent(new Event("miku-room-change")); window.mikuFocus.restorePlayer();
    if (text) message(text);
  }
  function reconnect() {
    if (!session || reconnectTimer) return;
    online = false;
    message("网络连接中断，正在自动重连。房间和歌单会保留。", true);
    reconnectTimer = setTimeout(() => { reconnectTimer = 0; connect({ type: "resume", ...session }); }, Math.min(15000, 700 * 2 ** Math.min(retry++, 5)));
  }
  function connect(request) {
    recovering = request.type === "resume";
    busyState(true);
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/room`);
    socket = ws;
    const timeout = setTimeout(() => { if (socket === ws && !online) ws.close(); }, 30000);
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === "welcome") {
        if (data.protocol !== 2) { resetRoom("房间服务版本较旧，请重启学习房间服务。"); return; }
        serverOffset = data.serverNow - Date.now(); bestRtt = Infinity;
        send(request); send({ type: "ping", clientTime: Date.now() });
      } else if (data.type === "session") {
        session = { code: data.code, token: data.token, id: data.id, name: data.name };
        storeSession(); try { localStorage.setItem("mikuFocusNickname", data.name); } catch {}
        online = true; retry = 0; clearTimeout(timeout);
        const url = new URL(location.href); url.hash = `room=${data.code}`; history.replaceState(null, "", url);
      } else if (data.type === "room") updateRoom(data);
      else if (data.type === "pong") {
        const rtt = Date.now() - data.clientTime;
        if (rtt < bestRtt) { bestRtt = rtt; serverOffset = data.serverNow - (data.clientTime + rtt / 2); }
      } else if (data.type === "resume-expired") { resetRoom(data.message); openPanel(true); }
      else if (data.type === "error") { clearControl(); renderPlayer(); if (!room && !session) { busyState(false); clearTimeout(timeout); } message(data.message, true); }
      else if (data.type === "ended" || data.type === "left") resetRoom(data.message || "已离开房间，个人计时会继续。");
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timeout);
      if (socket !== ws) return;
      socket = null; online = false; clearControl(); renderPlayer();
      if (event.reason === "Session resumed elsewhere") { resetRoom("这个房间会话已在另一个页面恢复。"); return; }
      if (session) reconnect(); else { busyState(false); message("无法连接房间，请确认服务正在运行，然后重试。", true); }
    });
    ws.addEventListener("error", () => { if (socket === ws && !session) message("暂时无法连接房间服务。", true); });
  }
  async function enter(type) {
    if (busy || room) return;
    const name = el("roomName").value.trim();
    if (!name) { message("先填一个昵称吧。", true); el("roomName").focus(); return; }
    if (location.protocol === "file:") { message("请双击“启动工具/一键分享学习房间.cmd”，生成链接后再创建房间。也可用“启动学习房间.cmd”本机试用。", true); return; }
    const code = el("roomCode").value.trim().toUpperCase();
    if (type === "join" && !/^[A-F0-9]{12}$/.test(code)) { message("请输入邀请里的 12 位房间码。", true); return; }
    message("正在连接学习房间…");
    listening = true; audio.muted = false; audio.volume = window.mikuFocus.getVolume();
    if (socket) { const old = socket; socket = null; old.close(); }
    connect({ type, name, code });
  }
  function current() { return room?.queue.find((t) => t.id === room.playback.trackId); }
  function targetPosition() {
    if (!room) return 0;
    const p = room.playback;
    return Math.min(current()?.duration || 43200, p.position + (p.playing ? Math.max(0, Date.now() + serverOffset - p.updatedAt) / 1000 : 0));
  }
  async function syncAudio() {
    if (!room) return;
    const track = current();
    if (!track) {
      if (currentTrack) { audio.pause(); audio.removeAttribute("src"); audio.load(); currentTrack = null; }
      renderPlayer(); return;
    }
    if (track.requiresLogin && !window.mikuNetease?.loggedIn) {
      if (currentTrack) { audio.pause(); audio.removeAttribute("src"); audio.load(); currentTrack = null; }
      message("这首歌需要账号权限，请在音乐导入窗口扫码登录网易云。", true); renderPlayer(); return;
    }
    if (currentTrack !== track.id) { currentTrack = track.id; audio.src = track.url; audio.load(); }
    const at = targetPosition();
    if (audio.readyState >= 1 && Math.abs(audio.currentTime - at) > 1) audio.currentTime = at;
    audio.volume = window.mikuFocus.getVolume(); audio.muted = !listening;
    if (room.playback.playing) {
      if (audio.paused) {
        try { await audio.play(); } catch { if (room) { el("roomListen").textContent = "点击开始收听"; message("已加入房间。点击“开始收听”启用声音。"); } }
      }
    } else audio.pause();
    renderPlayer();
  }
  function renderPlayer() {
    if (!room) return;
    const track = current();
    for (const id of ["btnPlay", "btnPrev", "btnNext"]) el(id).disabled = !online || Boolean(pendingControl);
    el("npName").textContent = track ? `一起听 · ${track.name}` : "共享歌单为空，点 ＋ 添加音乐";
    el("btnPlay").innerHTML = room.playback.playing ? pauseIcon : playIcon;
    el("btnPlay").title = room.playback.playing ? "暂停所有人的音乐" : "一起播放";
    el("seekBar").disabled = !track;
    el("timeDur").textContent = fmt(track?.duration || 0);
    const queueKey = JSON.stringify(room.queue) + room.playback.trackId;
    if (queueKey !== renderedQueue) {
      renderedQueue = queueKey; el("playlist").replaceChildren();
      if (!room.queue.length) {
        const empty = document.createElement("li"); empty.className = "pl-empty"; empty.textContent = "每个人都可以点 ＋ 添加音乐。歌曲会临时保存在房间服务。"; el("playlist").append(empty);
      }
      room.queue.forEach((t, i) => {
        const li = document.createElement("li"); li.className = "pl-row" + (track?.id === t.id ? " playing" : "");
        const index = document.createElement("span"); index.className = "pl-idx"; index.textContent = String(i + 1);
        const name = document.createElement("span"); name.className = "pl-name"; name.textContent = t.name; name.title = `${t.name}${t.artist ? " · " + t.artist : ""} · ${t.addedBy} 添加`;
        const dur = document.createElement("span"); dur.className = "pl-dur"; dur.textContent = (t.requiresLogin ? "需登录 · " : t.source === "netease" ? "网易云 · " : "") + fmt(t.duration);
        const del = document.createElement("button"); del.className = "pl-del"; del.textContent = "×"; del.title = "从共享歌单移除";
        del.addEventListener("click", (e) => { e.stopPropagation(); send({ type: "remove-track", trackId: t.id }); });
        li.append(index, name, dur, del); li.addEventListener("click", () => send({ type: "playback", action: "select", trackId: t.id })); el("playlist").append(li);
      });
    }
  }
  function fmt(value) { const n = Math.max(0, Math.floor(value || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; }
  function updateRoom(data) {
    if (!session) return;
    const entering = !room;
    data.members.forEach((m) => { m.receivedAt = Date.now(); }); room = data; online = true;
    if (pendingControl && data.playback.version > pendingControl.version) clearControl();
    busyState(false); el("roomLobby").hidden = true; el("roomActive").hidden = false; el("roomListen").hidden = false;
    el("roomDot").hidden = false; el("roomLaunchLabel").textContent = `一起学习 · ${data.members.filter((m) => m.online).length}`;
    el("roomActiveCode").textContent = data.code;
    el("roomRole").textContent = data.hostId === session.id ? "你是房主。每个人都能添加音乐、切歌和暂停；你离开后会自动转移房主。" : "共享歌单由大家一起控制。暂停收听和音量仅影响自己。";
    el("roomEnd").hidden = data.hostId !== session.id;
    el("roomSong").textContent = current()?.name || "等待大家添加音乐";
    el("roomPlayback").textContent = data.playback.playing ? "正在一起播放" : "音乐已暂停 / 尚未播放";
    if (!audio.paused || !data.playback.playing) el("roomListen").textContent = listening ? "暂停收听（仅自己）" : "继续收听";
    el("btnMode").disabled = true; el("btnMode").title = "房间歌单按顺序循环";
    document.body.classList.add("room-connected");
    if (entering) {
      el("audio").pause(); window.dispatchEvent(new Event("miku-room-change")); publishStudy();
      message(publicUrl || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) ? "房间已就绪，复制邀请给朋友即可加入。" : "房间已就绪。远程邀请请使用“启动工具/一键分享学习房间.cmd”生成的 HTTPS 链接。");
    }
    if (recovering) { message("已恢复房间，歌单和成员状态已同步。"); recovering = false; }
    renderMembers(); renderPlayer(); syncAudio();
  }
  function renderMembers() {
    if (!room) return;
    el("roomMembers").replaceChildren();
    for (const m of room.members) {
      const li = document.createElement("li"); li.className = "room-member"; li.dataset.status = m.status;
      const name = document.createElement("span"); name.className = "room-member-name"; name.textContent = m.name + (m.id === room.hostId ? " · 房主" : "") + (m.id === session?.id ? " · 你" : "");
      const state = document.createElement("span"); state.className = "room-member-state";
      state.textContent = m.online ? `${statusNames[m.status]} ${fmt((m.elapsedMs + (m.status === "study" ? Date.now() - m.receivedAt : 0)) / 1000)}` : "暂时离线";
      li.append(name, state); el("roomMembers").append(li);
    }
  }
  function control(action, fraction) {
    if (!room || pendingControl) return;
    if (action === "toggle") action = room.playback.playing ? "pause" : "play";
    if (send({ type: "playback", action, ...(action === "seek" ? { position: (current()?.duration || 0) * fraction } : {}) })) {
      pendingControl = { version: room.playback.version }; renderPlayer();
      controlTimer = setTimeout(() => { clearControl(); renderPlayer(); }, 15000);
    }
  }
  function durationOf(file) {
    return new Promise((resolve, reject) => {
      const probe = document.createElement("audio"), url = URL.createObjectURL(file);
      const finish = (err) => { clearTimeout(timer); const duration = probe.duration; probe.removeAttribute("src"); probe.load(); URL.revokeObjectURL(url); err ? reject(err) : resolve(duration); };
      const timer = setTimeout(() => finish(new Error("读取音频超时")), 10000);
      probe.onloadedmetadata = () => Number.isFinite(probe.duration) && probe.duration > 0 ? finish() : finish(new Error("音频时长无效"));
      probe.onerror = () => finish(new Error("浏览器无法播放这首音乐")); probe.preload = "metadata"; probe.src = url;
    });
  }
  async function importFiles(files) {
    if (!room || !online) { message("请等待房间连接恢复。", true); return; }
    if (uploading) { message("正在添加音乐，请稍候。", true); return; }
    uploading = true; const activeSession = session; uploadAbort = new AbortController();
    try {
      let done = 0;
      for (const file of files) {
        if (session !== activeSession) break;
        if (file.size > 50 * 1024 * 1024) { message(`${file.name} 超过 50 MB，请选择更小的文件。`, true); continue; }
        message(`正在添加 ${done + 1}/${files.length}：${file.name}…`);
        const duration = await durationOf(file);
        if (session !== activeSession) break;
        const response = await fetch(`/api/rooms/${activeSession.code}/tracks`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "Authorization": `Bearer ${activeSession.token}`, "X-File-Name": encodeURIComponent(file.name), "X-Duration": String(duration) }, body: file, signal: uploadAbort.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "添加失败");
        done++;
      }
      if (session === activeSession) message(`已添加 ${done} 首到共享歌单。每个人都可以点播放开始听。`);
    } catch (err) { if (session === activeSession && err.name !== "AbortError") message(`添加音乐失败：${err.message}`, true); }
    finally { uploading = false; uploadAbort = null; }
  }
  function publishStudy() { if (room && online) send({ type: "study", ...window.mikuFocus.getStudy() }); }
  async function importNetease(playlistId) {
    if (!room || !online) throw new Error("请等待房间连接恢复。");
    const activeSession = session;
    const response = await fetch(`/api/rooms/${session.code}/netease`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ playlistId }) });
    if (response.status === 404) throw new Error("请重启学习房间服务后再导入。");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "导入失败");
    if (session !== activeSession) throw new Error("房间状态已改变，请重新打开播放列表。");
    return result;
  }
  window.mikuRoom = {
    get active() { return Boolean(room); }, get isGuest() { return Boolean(room && room.hostId !== session?.id); },
    setLocalVolume(value) { audio.volume = value; return false; }, getLocalVolume() { return null; },
    control, importFiles, importNetease, renderPlayer,
  };
  el("roomLaunch").addEventListener("click", () => openPanel(panel.hidden));
  el("roomClose").addEventListener("click", () => openPanel(false));
  el("roomCreate").addEventListener("click", () => enter("create"));
  el("roomJoinForm").addEventListener("submit", (e) => { e.preventDefault(); enter("join"); });
  el("roomAddMusic").addEventListener("click", () => el("fileInput").click());
  el("roomLeave").addEventListener("click", () => { send({ type: "leave" }); resetRoom("已离开房间，个人计时会继续。"); });
  el("roomEnd").addEventListener("click", () => send({ type: "close-room" }));
  el("roomListen").addEventListener("click", async () => {
    if (!room) return;
    if (audio.paused && room.playback.playing) { listening = true; await syncAudio(); }
    else { listening = !listening; audio.muted = !listening; }
    el("roomListen").textContent = listening ? "暂停收听（仅自己）" : "继续收听";
  });
  el("roomCopy").addEventListener("click", async () => {
    if (!room) return;
    const url = new URL(publicUrl || location.href); url.hash = `room=${room.code}`;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) { message("还没有远程链接。请双击“启动工具/一键分享学习房间.cmd”，在自动打开的 HTTPS 页面创建房间后复制邀请。", true); return; }
    try { await navigator.clipboard.writeText(url.href); message("邀请链接已复制，朋友打开后填昵称即可加入。"); }
    catch {
      // HTTP inside a private VPN may not expose navigator.clipboard.
      // Keep copying within the click gesture and restore the user's focus.
      const active = document.activeElement;
      const input = document.createElement("textarea");
      input.value = url.href;
      input.readOnly = true;
      input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0";
      document.body.append(input); input.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch {}
      input.remove(); active?.focus({ preventScroll: true });
      message(copied ? "邀请链接已复制，朋友连上同一个 Radmin 网络后即可打开。" : `请手动复制邀请：${url.href}`);
    }
  });
  function syncVolume() { const value = Math.round(window.mikuFocus.getVolume() * 100); el("roomVolume").value = value; el("roomVolumeValue").textContent = `${value}%`; audio.volume = value / 100; }
  el("roomVolume").addEventListener("input", () => window.mikuFocus.setVolume(Number(el("roomVolume").value) / 100));
  window.addEventListener("miku-volume-change", syncVolume); syncVolume();
  window.addEventListener("miku-netease-auth", () => { if (room) syncAudio(); });
  audio.addEventListener("loadedmetadata", () => { if (room) { audio.currentTime = targetPosition(); syncAudio(); } });
  audio.addEventListener("error", () => { if (room && currentTrack) { message(current()?.source === "netease" ? "这首网易云歌曲暂时无法播放，请检查登录权限或稍后重试。" : "音频暂时无法加载，请检查网络或切换歌曲。", true); if (current()?.source === "netease") window.mikuNetease?.refreshAuth().catch(() => {}); } });
  audio.addEventListener("timeupdate", () => { if (room) { el("timeCur").textContent = fmt(audio.currentTime); if (document.activeElement !== el("seekBar")) el("seekBar").value = current()?.duration ? Math.round(audio.currentTime / current().duration * 1000) : 0; } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { openPanel(false); el("roomLaunch").focus(); } });
  window.addEventListener("miku-study-change", publishStudy);
  window.addEventListener("online", () => { if (session && !online) { clearTimeout(reconnectTimer); reconnectTimer = 0; connect({ type: "resume", ...session }); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && room) { if (!online && session) reconnect(); else { send({ type: "ping", clientTime: Date.now() }); publishStudy(); syncAudio(); } } });
  setInterval(() => { publishStudy(); if (online) send({ type: "ping", clientTime: Date.now() }); }, 5000);
  setInterval(renderMembers, 1000);
  if (location.protocol !== "file:") fetch("/api/config").then((r) => r.json()).then((config) => {
    publicUrl = config.publicOrigin;
    if (publicUrl || location.protocol === "https:") el("roomAccessHint").textContent = "链接加入 · 共享歌单 · 刷新自动恢复 · 最多 6 人";
    else if (/^26\./.test(location.hostname)) el("roomAccessHint").textContent = "Radmin 组网 · 请先连接同一个 Radmin 网络再加入 · 最多 6 人";
  }).catch(() => {});
  const invite = new URLSearchParams(location.hash.slice(1)).get("room");
  if (session && invite && invite.toUpperCase() !== session.code) { session = null; storeSession(); }
  if (/^[a-f0-9]{12}$/i.test(invite || "")) { el("roomCode").value = invite.toUpperCase(); openPanel(true); message("朋友邀请你一起学习。填好昵称，点击加入即可。"); }
  if (session?.token && session?.code && location.protocol !== "file:" && (!invite || invite.toUpperCase() === session.code)) { message("正在恢复上次的房间…"); connect({ type: "resume", ...session }); }
})();
