/* Optional room layer. No music files, todos, or credentials are uploaded. */
(() => {
  "use strict";
  const el = (id) => document.getElementById(id);
  const localAudio = el("audio"), remoteAudio = el("roomAudio");
  const panel = el("roomPanel");
  const peers = new Map();
  const disabledControls = new Map();
  const statusNames = { idle: "准备中", study: "专注中", paused: "已暂停", break: "休息中" };
  let socket = null, myId = null, room = null, config = null, busy = false;
  let context = null, source = null, output = null, localGain = null;
  let listening = true, sharedTitle = "", previousTitle = "", lastTrack = "";
  let studyTimer = 0;
  let connectionTimer = 0;
  let signalQueue = Promise.resolve();

  function message(text, isError = false) {
    el("roomMessage").textContent = text;
    el("roomMessage").dataset.error = String(isError);
  }
  function openPanel(open) {
    panel.hidden = !open;
    el("roomLaunch").setAttribute("aria-expanded", String(open));
  }
  function send(data) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  }
  function isHost() { return Boolean(room && room.hostId === myId); }
  function isGuest() { return Boolean(room && room.hostId !== myId); }
  function busyState(value) {
    busy = value;
    for (const id of ["roomCreate", "roomJoin", "roomName", "roomCode"]) el(id).disabled = value;
  }
  function closePeer(id) {
    const entry = peers.get(id);
    if (!entry) return;
    peers.delete(id);
    entry.pc.close();
  }
  function setGuestControls(guest) {
    const ids = ["btnPrev", "btnPlay", "btnNext", "btnImport", "btnMode", "btnList", "seekBar"];
    for (const id of ids) {
      const button = el(id);
      if (guest && !disabledControls.has(id)) { disabledControls.set(id, button.disabled); button.disabled = true; }
      if (!guest && disabledControls.has(id)) { button.disabled = disabledControls.get(id); disabledControls.delete(id); }
    }
    document.body.classList.toggle("room-guest", guest);
  }

  function resetRoom(text) {
    const wasGuest = isGuest();
    const oldSocket = socket;
    socket = null;
    room = null; myId = null; config = null; lastTrack = "";
    clearInterval(studyTimer);
    clearTimeout(connectionTimer);
    for (const id of [...peers.keys()]) closePeer(id);
    remoteAudio.pause(); remoteAudio.srcObject = null;
    if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) oldSocket.close();
    if (output) output.stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    setGuestControls(false);
    if (wasGuest) el("npName").textContent = previousTitle;
    el("roomActive").hidden = true; el("roomLobby").hidden = false;
    el("roomDot").hidden = true; el("roomLaunchLabel").textContent = "一起学习";
    el("roomMembers").replaceChildren();
    busyState(false);
    if (text) message(text);
    window.dispatchEvent(new Event("miku-room-change"));
  }

  // Keep the graph for the lifetime of the media element: browsers only allow one
  // MediaElementAudioSource per element. The send branch is before local volume.
  async function prepareAudio() {
    if (!context) {
      context = new AudioContext();
      localGain = context.createGain();
      localGain.gain.value = window.mikuFocus.getVolume();
      output = context.createMediaStreamDestination();
      source = context.createMediaElementSource(localAudio);
      source.connect(output);
      source.connect(localGain);
      localGain.connect(context.destination);
      localAudio.volume = 1;
    }
    await context.resume();
    output.stream.getAudioTracks().forEach((t) => { t.enabled = true; });
  }

  async function enter(type) {
    if (busy || room) return;
    const name = el("roomName").value.trim();
    if (!name) { message("先填一个昵称吧。", true); el("roomName").focus(); return; }
    if (location.protocol === "file:") {
      message("当前是离线页面。请用项目里的“启动学习房间.cmd”启动，再打开 http://localhost:8642。", true); return;
    }
    if (!window.isSecureContext || !window.RTCPeerConnection || !window.AudioContext) {
      message("多人收听需要 HTTPS 页面（本机可用 localhost），请用新版 Chrome 或 Edge 打开。", true); return;
    }
    const code = el("roomCode").value.trim().toUpperCase();
    if (type === "join" && !/^[A-F0-9]{12}$/.test(code)) { message("请输入邀请里的 12 位房间码。", true); return; }
    busyState(true);
    message("正在连接学习房间…");
    try {
      if (type === "create") await prepareAudio();
      else {
        listening = true;
        remoteAudio.muted = false;
        remoteAudio.volume = window.mikuFocus.getVolume();
        // Attempt within the user gesture; ontrack also handles autoplay rejection.
        remoteAudio.play().catch(() => {});
      }
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/room`);
      socket = ws;
      const timeout = setTimeout(() => {
        if (socket === ws && !room) resetRoom("连接超时，请确认房间服务正在运行，再重试。");
      }, 12000);
      ws.addEventListener("message", (event) => {
        if (socket !== ws) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === "welcome") {
          config = msg; myId = msg.id;
          send({ type, name, code });
        } else if (msg.type === "room") {
          clearTimeout(timeout);
          updateRoom(msg);
        } else if (msg.type === "signal") {
          // Serialize SDP and ICE so candidates cannot overtake setRemoteDescription.
          signalQueue = signalQueue.then(() => socket === ws && handleSignal(msg)).catch(() => {
            if (socket === ws) message("音频连接未成功，可以点击重新连接，或离开后再加入。", true);
          });
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          if (!room) resetRoom(msg.message);
          message(msg.message, true);
        } else if (msg.type === "ended" || msg.type === "left") {
          resetRoom(msg.message || "已离开房间，个人计时会继续。");
        }
      });
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        if (socket === ws) resetRoom("连接已断开，房间收听已停止。可以重新创建或加入房间。");
      });
      ws.addEventListener("error", () => {
        if (socket === ws) message("无法连接房间服务，请检查服务与网络。", true);
      });
    } catch (err) {
      resetRoom("暂时无法启动共享音频，请重试或使用新版 Chrome / Edge。");
      message(`无法启动房间：${err.message}`, true);
    }
  }

  function publishStudy() {
    if (room) send({ type: "study", ...window.mikuFocus.getStudy() });
  }
  function publishTrack() {
    if (!isHost()) return;
    const track = window.mikuFocus.getTrack();
    const signature = JSON.stringify(track);
    if (signature === lastTrack) return;
    lastTrack = signature;
    send({ type: "track", ...track });
  }
  function updateRoom(data) {
    data.members.forEach((m) => { m.receivedAt = Date.now(); });
    const entering = !room;
    if (entering) previousTitle = el("npName").textContent;
    room = data;
    busyState(false);
    el("roomLobby").hidden = true; el("roomActive").hidden = false;
    el("roomDot").hidden = false;
    el("roomLaunchLabel").textContent = `一起学习 · ${data.members.length}`;
    el("roomActiveCode").textContent = data.code;
    el("roomRole").textContent = isHost() ? "你是房主：用底部播放器导入音乐、播放和切歌。音量只影响你自己。" : "音乐由房主播放。你可以独立调节音量、暂停收听和学习计时。";
    el("roomListen").hidden = isHost();
    el("roomLeave").textContent = isHost() ? "结束房间" : "离开房间";
    setGuestControls(isGuest());
    el("roomSong").textContent = data.track.name || "等待房主播放音乐";
    el("roomPlayback").textContent = data.track.playing ? "房主正在播放" : "房主已暂停 / 尚未播放";
    if (isGuest()) {
      sharedTitle = data.track.name;
      el("npName").textContent = `一起听 · ${sharedTitle}`;
    }
    const ids = new Set(data.members.map((m) => m.id));
    for (const id of peers.keys()) if (!ids.has(id)) closePeer(id);
    renderMembers();
    if (entering) {
      window.dispatchEvent(new Event("miku-room-change"));
      publishStudy();
      studyTimer = setInterval(publishStudy, 5000);
      if (isGuest()) {
        localAudio.pause();
        el("playlist").classList.remove("open");
        el("roomListen").textContent = "重新连接收听";
        send({ type: "signal", to: room.hostId, signal: { kind: "ready" } });
        message("已加入，正在连接房主的音乐…");
      } else {
        message(config.hasTurn ? "房间已创建，可以复制邀请给朋友。" : "房间已创建。跨网络收听仍需实测，连接不通时需要配置音频中转。");
      }
    }
    publishTrack();
  }
  function renderMembers() {
    if (!room) return;
    const list = el("roomMembers");
    list.replaceChildren();
    for (const member of room.members) {
      const li = document.createElement("li"); li.className = "room-member";
      li.dataset.status = member.status;
      const name = document.createElement("span"); name.className = "room-member-name";
      name.textContent = member.name + (member.id === room.hostId ? " · 房主" : "") + (member.id === myId ? " · 你" : "");
      const state = document.createElement("span"); state.className = "room-member-state";
      // Use time since receipt rather than comparing two users' device clocks.
      const elapsed = member.elapsedMs + (member.status === "study" ? Math.max(0, Date.now() - (member.receivedAt || Date.now())) : 0);
      const seconds = Math.floor(elapsed / 1000);
      state.textContent = `${statusNames[member.status]} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      li.append(name, state); list.append(li);
    }
  }

  function peer(id) {
    if (peers.has(id)) return peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    const entry = { pc, candidates: [] };
    peers.set(id, entry);
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) send({ type: "signal", to: id, signal: { kind: "ice", candidate: event.candidate.toJSON() } });
    });
    pc.addEventListener("connectionstatechange", () => {
      if (!room || peers.get(id) !== entry) return;
      if (pc.connectionState === "connected") {
        if (isGuest()) clearTimeout(connectionTimer);
        message(isHost() ? "朋友已连接，正在共享播放器音乐。" : "音频已连接。学习计时与音量由你自己控制。");
      } else if (["failed", "disconnected"].includes(pc.connectionState)) {
        message("音频连接中断。可以重新连接收听；持续失败时需要检查网络或中转配置。", true);
        if (isGuest()) el("roomListen").textContent = "重新连接收听";
      }
    });
    pc.addEventListener("track", async (event) => {
      if (!isGuest() || peers.get(id) !== entry) return;
      remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
      remoteAudio.muted = !listening;
      try {
        await remoteAudio.play();
        el("roomListen").textContent = listening ? "暂停收听" : "继续收听";
      } catch {
        el("roomListen").textContent = "点击开始收听";
        message("连接已建立，点击“开始收听”启用声音。");
      }
    });
    return entry;
  }
  async function applyCandidates(entry) {
    for (const candidate of entry.candidates.splice(0)) await entry.pc.addIceCandidate(candidate);
  }
  async function handleSignal(msg) {
    if (!room || !room.members.some((m) => m.id === msg.from)) return;
    const signal = msg.signal;
    if (signal.kind === "ready" && isHost()) {
      closePeer(msg.from);
      const entry = peer(msg.from);
      for (const track of output.stream.getAudioTracks()) entry.pc.addTrack(track, output.stream);
      const sender = entry.pc.getSenders()[0];
      const parameters = sender.getParameters();
      if (parameters.encodings?.length) {
        parameters.encodings[0].maxBitrate = 192000;
        await sender.setParameters(parameters);
      }
      await entry.pc.setLocalDescription(await entry.pc.createOffer());
      send({ type: "signal", to: msg.from, signal: { kind: "offer", description: entry.pc.localDescription } });
    } else if (signal.kind === "offer" && isGuest() && msg.from === room.hostId) {
      const entry = peer(msg.from);
      clearTimeout(connectionTimer);
      connectionTimer = setTimeout(() => {
        if (isGuest() && peers.get(msg.from) === entry && entry.pc.connectionState !== "connected") {
          message("暂时连不上房主的音频。可以重连；跨网络持续失败时需要配置音频中转。", true);
          el("roomListen").textContent = "重新连接收听";
          closePeer(msg.from);
        }
      }, 20000);
      await entry.pc.setRemoteDescription(signal.description);
      await applyCandidates(entry);
      await entry.pc.setLocalDescription(await entry.pc.createAnswer());
      send({ type: "signal", to: msg.from, signal: { kind: "answer", description: entry.pc.localDescription } });
    } else if (signal.kind === "answer" && isHost()) {
      const entry = peers.get(msg.from);
      if (!entry) return;
      await entry.pc.setRemoteDescription(signal.description);
      await applyCandidates(entry);
    } else if (signal.kind === "ice") {
      const entry = peer(msg.from);
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(signal.candidate);
      else entry.candidates.push(signal.candidate);
    }
  }

  window.mikuRoom = {
    get active() { return Boolean(room); },
    get isGuest() { return isGuest(); },
    setLocalVolume(value) {
      remoteAudio.volume = value;
      if (localGain) { localGain.gain.value = value; return true; }
      return false;
    },
    getLocalVolume() { return localGain ? localGain.gain.value : null; },
  };

  el("roomLaunch").addEventListener("click", () => openPanel(panel.hidden));
  el("roomClose").addEventListener("click", () => openPanel(false));
  el("roomCreate").addEventListener("click", () => enter("create"));
  el("roomJoinForm").addEventListener("submit", (event) => { event.preventDefault(); enter("join"); });
  function syncVolume() {
    const value = Math.round(window.mikuFocus.getVolume() * 100);
    el("roomVolume").value = value;
    el("roomVolumeValue").textContent = `${value}%`;
  }
  el("roomVolume").addEventListener("input", () => window.mikuFocus.setVolume(Number(el("roomVolume").value) / 100));
  window.addEventListener("miku-volume-change", syncVolume);
  syncVolume();
  el("roomLeave").addEventListener("click", () => {
    send({ type: "leave" }); resetRoom("已离开房间，个人计时会继续。");
  });
  el("roomListen").addEventListener("click", async () => {
    if (!isGuest()) return;
    const current = peers.get(room.hostId)?.pc;
    if (!current || ["failed", "disconnected", "closed"].includes(current.connectionState)) {
      closePeer(room.hostId);
      send({ type: "signal", to: room.hostId, signal: { kind: "ready" } });
      message("正在重新连接音乐…"); return;
    }
    if (remoteAudio.paused) {
      try { await remoteAudio.play(); listening = true; }
      catch { message("暂时无法播放，请重试。", true); return; }
    } else listening = !listening;
    remoteAudio.muted = !listening;
    el("roomListen").textContent = listening ? "暂停收听" : "继续收听";
  });
  el("roomCopy").addEventListener("click", async () => {
    if (!room) return;
    const url = new URL(location.href); url.hash = `room=${room.code}`;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    try {
      await navigator.clipboard.writeText(local ? room.code : url.href);
      message(local ? "房间码已复制。远程朋友需要公网 HTTPS 地址，localhost 仅供本机测试。" : "邀请链接已复制，发给朋友即可加入。");
    } catch { message(`请手动复制${local ? "房间码" : "邀请链接"}：${local ? room.code : url.href}`); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) { openPanel(false); el("roomLaunch").focus(); }
  });
  for (const event of ["play", "pause", "emptied", "loadedmetadata"]) localAudio.addEventListener(event, publishTrack);
  window.addEventListener("miku-study-change", publishStudy);
  window.addEventListener("pagehide", () => socket?.close());
  setInterval(() => {
    if (room) renderMembers();
  }, 1000);
  const inviteCode = new URLSearchParams(location.hash.slice(1)).get("room");
  if (/^[a-f0-9]{12}$/i.test(inviteCode || "")) {
    el("roomCode").value = inviteCode.toUpperCase();
    openPanel(true); message("朋友邀请你一起学习。填好昵称，点击加入即可。");
  }
})();
