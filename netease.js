/* Playlist import and optional QR authorization. Provider credentials never enter this page. */
(() => {
  "use strict";
  const el = (id) => document.getElementById(id), mask = el("neteaseModal");
  let preview = null, busy = false, request = null, previousFocus = null;
  let auth = { loggedIn: false, name: "", csrf: "" }, authReady = null, qrTimer = 0, qrVersion = 0, qrPending = false, cancelPending = Promise.resolve();
  const authChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("miku-netease-auth") : null;
  function authError(message, status = 502) { return Object.assign(new Error(message), { status, retryable: status === 0 || status === 408 || status === 429 || status >= 500 }); }
  async function authJson(path, options = {}) {
    let response;
    try { response = await fetch("/api/netease/auth/" + path, { ...options, cache: "no-store", signal: AbortSignal.timeout(15000) }); }
    catch { throw authError("登录连接暂时中断", 0); }
    let data;
    try { data = await response.json(); }
    catch { throw authError("登录连接暂时未返回有效状态", response.ok ? 502 : response.status); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw authError("登录服务暂未返回有效状态");
    if (!response.ok) throw authError(data.error || "登录服务暂时无法连接", response.status);
    return data;
  }
  function invalidatePreview() { request?.abort(); request = null; preview = null; el("neteaseResults").hidden = true; setBusy(false); }
  function applyAuth(data) {
    const changed = auth.loggedIn !== data.loggedIn || auth.name !== data.name;
    auth = data;
    el("neteaseAccount").textContent = data.loggedIn ? `已登录 · ${data.name}` : "未登录网易云";
    el("neteaseAccountHint").textContent = data.loggedIn ? "使用你的账号权限获取歌曲。退出后清除本次登录。" : "可直接导入公开音源，也可以扫码使用自己的账号权限。";
    el("neteaseLogin").hidden = data.loggedIn; el("neteaseLogout").hidden = !data.loggedIn;
    if (changed) {
      invalidatePreview();
      if (!data.loggedIn) window.mikuFocus.clearAccountTracks();
      window.dispatchEvent(new CustomEvent("miku-netease-auth", { detail: { loggedIn: data.loggedIn } }));
      status(data.loggedIn ? "登录成功。请重新读取歌单，按你的账号权限检查歌曲。" : "已退出登录，可继续导入公开音源。");
    }
  }
  function refreshAuth() {
    if (location.protocol === "file:") return Promise.resolve();
    if (authReady) return authReady;
    authReady = authJson("status").then(data => { if (typeof data.loggedIn !== "boolean" || typeof data.csrf !== "string") throw authError("登录服务暂未返回有效状态"); applyAuth(data); }).finally(() => { authReady = null; });
    return authReady;
  }
  async function authPost(path) {
    if (!auth.csrf) await refreshAuth();
    try { return await authJson(path, { method: "POST", headers: { "X-CSRF-Token": auth.csrf } }); }
    catch (err) { if (err.status === 401 || err.status === 403) await refreshAuth().catch(() => {}); throw err; }
  }
  function hideQr() { qrVersion++; clearTimeout(qrTimer); el("neteaseLogin").disabled = false; el("neteaseQrPanel").hidden = true; el("neteaseQrImage").removeAttribute("src"); el("neteaseQrImage").hidden = true; }
  async function cancelQr() {
    const pending = qrPending; qrPending = false; hideQr();
    if (pending && !auth.loggedIn) {
      cancelPending = authPost("logout").then(data => { applyAuth(data); authChannel?.postMessage("changed"); }).catch(() => {});
      await cancelPending;
    }
  }
  async function startQr() {
    await cancelQr(); await cancelPending;
    const version = ++qrVersion; qrPending = true; el("neteaseLogin").disabled = true; el("neteaseQrPanel").hidden = false;
    el("neteaseOfficial").hidden = true;
    el("neteaseQrStatus").textContent = "正在生成二维码…"; el("neteaseQrRefresh").disabled = true;
    try {
      const data = await authPost("qr");
      if (version !== qrVersion) return;
      el("neteaseQrImage").src = data.image; el("neteaseQrImage").hidden = false;
      el("neteaseQrStatus").textContent = "等待扫码，请在手机上确认登录。";
      let failures = 0;
      const expires = Number(data.expiresAt) || Date.now() + 180000;
      function finish(data) { qrPending = false; hideQr(); applyAuth(data); authChannel?.postMessage("changed"); }
      async function poll() {
        if (version !== qrVersion || mask.hidden) return;
        if (Date.now() >= expires) { el("neteaseQrStatus").textContent = "二维码已过期，请刷新后重新扫码。"; el("neteaseQrImage").hidden = true; return; }
        try {
          const result = await authPost("check?challenge=" + encodeURIComponent(data.challenge));
          if (version !== qrVersion) return;
          if (result.code === 803 && !result.loggedIn) throw authError("手机已确认，正在核实登录状态");
          if (![800, 801, 802, 803].includes(result.code)) throw authError("暂未取得扫码状态");
          failures = 0;
          el("neteaseQrStatus").textContent = result.message;
          if (result.code === 803) { finish(result); return; }
          if (result.code === 800) { el("neteaseQrImage").hidden = true; return; }
          qrTimer = setTimeout(poll, 3000);
        } catch (err) {
          if (version !== qrVersion) return;
          // A gateway can lose the response after authorization has already completed.
          await refreshAuth().catch(() => {});
          if (version !== qrVersion) return;
          if (auth.loggedIn) { finish(auth); return; }
          if (err.retryable) {
            el("neteaseQrStatus").textContent = `${err.message}。正在自动重试；若手机已确认，无需重复扫码。`;
            qrTimer = setTimeout(poll, Math.min(10000, 3000 + failures++ * 2000));
          } else {
            el("neteaseQrStatus").textContent = err.message + (err.status === 423 ? "" : " 请刷新二维码重试。");
            if (err.status === 423) { el("neteaseQrImage").hidden = true; el("neteaseQrRefresh").disabled = true; el("neteaseOfficial").hidden = false; }
          }
        }
      }
      qrTimer = setTimeout(poll, 3000);
    } catch (err) { if (version === qrVersion) el("neteaseQrStatus").textContent = err.message; }
    finally { if (version === qrVersion) el("neteaseQrRefresh").disabled = false; }
  }
  el("neteaseLogin").addEventListener("click", startQr);
  el("neteaseQrRefresh").addEventListener("click", startQr);
  el("neteaseQrCancel").addEventListener("click", cancelQr);
  el("neteaseLogout").addEventListener("click", async () => {
    el("neteaseLogout").disabled = true;
    try { const data = await authPost("logout"); hideQr(); applyAuth(data); authChannel?.postMessage("changed"); }
    catch (err) { status(err.message, true); }
    finally { el("neteaseLogout").disabled = false; }
  });
  authChannel?.addEventListener("message", () => refreshAuth().catch(() => {}));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAuth().catch(() => {}); });
  function status(text, error = false) { el("neteaseStatus").textContent = text; el("neteaseStatus").dataset.error = String(error); }
  function setBusy(value) {
    busy = value; el("neteaseForm").setAttribute("aria-busy", String(value));
    el("neteaseCheck").disabled = value; el("neteaseLink").disabled = value;
    el("neteaseImport").disabled = value || !preview?.available;
    el("neteaseCheck").textContent = value ? "请稍候…" : "读取歌单";
  }
  function close() { request?.abort(); mask.hidden = true; setBusy(false); cancelQr(); previousFocus?.focus(); }
  function open() {
    previousFocus = document.activeElement; mask.hidden = false;
    if (!el("neteaseLink").value) { try { el("neteaseLink").value = localStorage.getItem("mikuFocusNeteaseLink") || ""; } catch {} }
    el("neteaseLink").focus();
    refreshAuth().catch(err => status(err.message, true));
  }
  function showPlaylist(data) {
    preview = data; el("neteaseResults").hidden = false;
    el("neteasePlaylistName").textContent = data.name;
    el("neteaseCounts").textContent = `共 ${data.total} 首 · 已检查 ${data.checked} 首 · 可导入 ${data.available} 首 · 暂不可播 ${data.checked - data.available} 首`;
    el("neteaseTracks").replaceChildren();
    data.tracks.forEach((t, i) => {
      const li = document.createElement("li"); li.className = "netease-track"; li.dataset.available = String(t.available);
      const index = document.createElement("span"); index.className = "netease-index"; index.textContent = String(i + 1).padStart(2, "0");
      const detail = document.createElement("div"); detail.className = "netease-track-detail";
      const name = document.createElement("a"); name.textContent = t.name; name.href = t.link; name.target = "_blank"; name.rel = "noopener noreferrer"; name.title = "在网易云查看";
      const artist = document.createElement("span"); artist.textContent = t.artist || "网易云音乐"; detail.append(name, artist);
      const badge = document.createElement("span"); badge.className = "netease-availability"; badge.textContent = t.available ? (t.requiresLogin ? "账号可播" : "可播放") : "暂不可播"; badge.title = t.reason || (t.requiresLogin ? "每位收听者需使用自己的账号权限" : "平台公开外链可用");
      li.append(index, detail, badge); el("neteaseTracks").append(li);
    });
    el("neteaseImport").textContent = `导入可播放的 ${data.available} 首`;
    status(data.available ? (window.mikuRoom?.active ? "将添加到当前房间的共享歌单；账号歌曲需每位成员各自登录。" : "将添加到你的播放列表，重复歌曲会跳过。") : "这份歌单暂时没有可用音源，可以登录后重试或在网易云客户端收听。", !data.available);
  }
  el("neteaseForm").addEventListener("submit", async (event) => {
    event.preventDefault(); if (busy) return;
    if (location.protocol === "file:") { status("网易云导入需要学习房间服务。请双击“启动学习房间.cmd”或“一键分享学习房间.cmd”后使用。", true); return; }
    request?.abort(); const controller = new AbortController(); request = controller;
    preview = null; el("neteaseResults").hidden = true; setBusy(true); status("正在读取歌单并逐首检查音源，请稍候…");
    try {
      const link = el("neteaseLink").value.trim();
      const response = await fetch("/api/netease/playlist?link=" + encodeURIComponent(link), { signal: controller.signal });
      if (response.status === 404) throw new Error("服务版本较旧，请关闭启动窗口并重新启动服务。");
      const data = await response.json(); if (!response.ok) { if (response.status === 401) await refreshAuth().catch(() => {}); throw new Error(data.error || "歌单读取失败"); }
      if (controller.signal.aborted) return;
      showPlaylist(data); try { localStorage.setItem("mikuFocusNeteaseLink", link); } catch {}
    } catch (err) { if (err.name !== "AbortError") status(err.message || "连接失败，请稍后重试。", true); }
    finally { if (request === controller) { request = null; setBusy(false); } }
  });
  el("neteaseImport").addEventListener("click", async () => {
    if (busy || !preview?.available) return;
    const data = preview; setBusy(true);
    try {
      const result = window.mikuRoom?.active ? await window.mikuRoom.importNetease(data.id) : window.mikuFocus.addOnlineTracks(data.tracks);
      close(); el("playlist").classList.add("open");
      toast(`已导入 ${result.added} 首网易云音乐${result.capacitySkipped ? "，播放列表已满，部分歌曲未添加" : result.added ? "，点击播放即可开始听" : "，重复歌曲已跳过"}。`);
    } catch (err) { status(err.message || "导入失败，请重试。", true); }
    finally { setBusy(false); }
  });
  el("neteaseLocal").addEventListener("click", () => { close(); el("fileInput").click(); });
  el("neteaseClose").addEventListener("click", close);
  mask.addEventListener("click", (event) => { if (event.target === mask) close(); });
  mask.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const focusable = [...mask.querySelectorAll("button:not(:disabled), input:not(:disabled), a[href]")].filter(e => e.getClientRects().length);
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
    }
  });
  el("roomImportNetease").addEventListener("click", open);
  window.mikuNetease = { open, get loggedIn() { return auth.loggedIn; }, refreshAuth };
  refreshAuth().catch(() => {});
})();
