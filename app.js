/* 初音未来专注 · Miku Focus */
"use strict";

const $ = (id) => document.getElementById(id);

/* ================= 图片轮播 ================= */

/* 壁纸组：学习与休息共用同一组（素材全部来自用户自己的 Wallpaper Engine） */
const WALLPAPERS = [
  { src: "assets/images/miku_guitar_night.jpg" },
  { src: "assets/images/miku_ribbon.jpg" },
  { src: "assets/images/miku_holiday.jpg" },
  { src: "assets/videos/miku_sea_color.mp4" },
  { src: "assets/videos/miku_moon_night.mp4" },
];

const layerA = $("layerA"), layerB = $("layerB");
let carouselList = WALLPAPERS;
let carouselIdx = 0;
let frontIsA = true;
let advanceTimer = 0;

const isVideoSrc = (src) => /\.(mp4|webm|ogv|mov|m4v)$/i.test(src);

function setImage(idx) {
  carouselIdx = (idx + carouselList.length) % carouselList.length;
  const item = carouselList[carouselIdx];
  const back = frontIsA ? layerB : layerA;
  const front = frontIsA ? layerA : layerB;
  const img = back.querySelector("img");
  const vid = back.querySelector("video");

  if (isVideoSrc(item.src)) {
    if (vid.getAttribute("src") !== item.src) {
      vid.src = item.src;
      vid.load();
    }
    img.style.display = "none";
    vid.style.display = "block";
    tryPlayStageVideo(vid);
  } else {
    vid.pause();
    vid.style.display = "none";
    img.style.display = "block";
    if (img.getAttribute("src") !== item.src) img.src = item.src;
  }

  back.classList.add("show");
  front.classList.remove("show");
  frontIsA = !frontIsA;

  // 过渡结束后停掉让位层的视频，省 GPU
  // 若 1.4s 内又发生切换，让位层可能已重新成为可见层——用 .show 状态判断，避免误暂停当前视频
  setTimeout(() => {
    if (!front.classList.contains("show")) {
      const fv = front.querySelector("video");
      if (fv) fv.pause();
    }
  }, 1400);

  scheduleNext();
}

/* 图片停留 30s；视频按自身时长播一遍再走（单个视频时 loop 属性保证无缝循环） */

function tryPlayStageVideo(vid) {
  vid.play().catch(() => {
    // 自动播放被拦截（刷新后手势失效）：等可播事件或首次交互续播
    vid.addEventListener("canplay", () => vid.play().catch(() => {}), { once: true });
  });
}

function resumeStageVideo() {
  const v = document.querySelector(".stage-layer.show video");
  if (v && v.style.display !== "none" && v.paused && v.getAttribute("src")) {
    v.play().catch(() => {});
  }
}
document.addEventListener("pointerdown", resumeStageVideo, true);
document.addEventListener("keydown", resumeStageVideo, true);

function scheduleNext() {
  clearTimeout(advanceTimer);
  const item = carouselList[carouselIdx];
  const ms = isVideoSrc(item.src) ? (item.dur ? Math.max(8000, item.dur * 1000) : 60000) : 30000;
  advanceTimer = setTimeout(() => setImage(carouselIdx + 1), ms);
}

function probeVideoMeta(item) {
  const v = document.createElement("video");
  v.preload = "metadata";
  v.muted = true;
  v.src = item.src;
  v.onloadedmetadata = () => {
    item.dur = v.duration;
    if (carouselList[carouselIdx] === item) scheduleNext();
    v.onloadedmetadata = null;
    v.removeAttribute("src");
    v.load();
  };
}

$("carousel").addEventListener("click", () => setImage(carouselIdx + 1));

WALLPAPERS.forEach((item) => {
  if (isVideoSrc(item.src)) probeVideoMeta(item);
  else new Image().src = item.src;
});
setImage(0);

/* ================= 计时状态机 ================= */

const IDLE = "idle", STUDY = "study", PAUSED = "paused", BREAK = "break";
let state = IDLE;

let segStudyMs = 0;     // 本段已累计的专注时间
let runStart = 0;       // 当前这次连续计时的起点
let segStartTs = 0;     // 本段开始的时间戳
let studySpans = [];    // 本段的学习区间 [{s, e|null}]，e 为 null 表示进行中（跨午夜按天记账用）（跨午夜拆分记账用）
let breakEndsAt = 0;    // 休息结束时刻
let breakTotalMs = 0;
let breakCount = 0;     // 本段休息次数
let goalHit = false;

const SIT_REMIND_MS = 50 * 60000; // 连续学习多久提醒一次休息（无 UI，要改时长改这里）
let contMs = 0;         // 距上次休息的连续专注累计（不含暂停，休息后清零）
let sitRemindCount = 0; // 本段连续学习已提醒的次数

const goalSelect = $("goalSelect");
const breakSelect = $("breakSelect");

/* 学习时只保留时长；靠近、键盘聚焦或点击时长可展开操作。 */
const timerCardEl = $("timerCard");
const timerToggle = $("timerToggle");
const timerDetails = $("timerDetails");
let timerHovered = false;
let timerHideTimeout = 0;
let timerPinned = false;
let timerKeyboardDismissed = false;

function syncTimerCard() {
  const active = document.activeElement;
  const keyboardInside = !timerKeyboardDismissed && timerCardEl.contains(active) && active.matches(":focus-visible");
  const collapsed = immersive || (state === STUDY && !timerHovered && !timerPinned && !keyboardInside);
  // 折叠时移出隐藏区域的焦点，inert 同时阻止误点击和 Tab 进入。
  if (collapsed && timerDetails.contains(active)) active.blur();
  timerCardEl.classList.toggle("collapsed", collapsed);
  timerDetails.inert = collapsed;
  timerDetails.setAttribute("aria-hidden", String(collapsed));
  timerToggle.disabled = state !== STUDY && !immersive;
  timerToggle.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "展开计时操作" : (state === STUDY ? (timerPinned ? "收起计时操作" : "固定展开计时操作") : "学习时长");
  timerToggle.setAttribute("aria-label", label);
  timerToggle.title = label;
}

timerCardEl.addEventListener("pointerenter", (e) => {
  if (e.pointerType === "touch") return;
  clearTimeout(timerHideTimeout);
  timerHovered = true;
  timerKeyboardDismissed = false;
  syncTimerCard();
});
timerCardEl.addEventListener("pointerleave", () => {
  clearTimeout(timerHideTimeout);
  timerHideTimeout = setTimeout(() => {
    timerHovered = false;
    syncTimerCard();
  }, 180);
});
timerCardEl.addEventListener("focusin", () => {
  timerKeyboardDismissed = false;
  syncTimerCard();
});
timerCardEl.addEventListener("focusout", () => requestAnimationFrame(syncTimerCard));
timerToggle.addEventListener("click", () => {
  if (immersive) setImmersive(false);
  if (state !== STUDY) return;
  timerPinned = !timerPinned;
  if (!timerPinned) {
    timerHovered = false;
    timerKeyboardDismissed = true;
  }
  syncTimerCard();
});
timerCardEl.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || state !== STUDY) return;
  timerPinned = false;
  timerHovered = false;
  timerToggle.focus();
  timerKeyboardDismissed = true;
  syncTimerCard();
});
document.addEventListener("pointerdown", (e) => {
  if (timerCardEl.contains(e.target)) return;
  timerPinned = false;
  timerKeyboardDismissed = true;
  syncTimerCard();
});

function studyElapsed() {
  return segStudyMs + (state === STUDY ? Date.now() - runStart : 0);
}

function setState(s) {
  if (s !== state) {
    timerPinned = false;
    timerKeyboardDismissed = false;
  }
  state = s;
  document.body.dataset.state = s;
  $("timerStatus").textContent = { idle: "准备开始", study: "专注中", paused: "已暂停", break: "休息一下" }[s];
  updateButtons();
  render();
  saveRunState(true);
  window.dispatchEvent(new Event("miku-study-change"));
}

/* ---------- 运行中计时的持久化（刷新/意外关闭后接续，见 §3.1） ---------- */

const RUN_KEY = "mikuFocusRun_v1";
let lastRunSave = 0;

function saveRunState(force = false) {
  if (state === IDLE) { localStorage.removeItem(RUN_KEY); return; }
  const now = Date.now();
  if (!force && now - lastRunSave < 5000) return;   // 常规节流 5s 一存
  lastRunSave = now;
  localStorage.setItem(RUN_KEY, JSON.stringify({
    state, segStudyMs, runStart, breakEndsAt, breakTotalMs,
    breakCount, goalHit, contMs, sitRemindCount, segStartTs,
    studySpans, savedAt: now,
    day: todayKey(),
  }));
}

function restoreRunState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(RUN_KEY)); } catch {}
  if (!saved || !saved.state || saved.state === IDLE) {
    localStorage.removeItem(RUN_KEY);
    return;
  }
  if (saved.day !== todayKey()) {
    // 跨天不接续：把已累计的学习区间（进行中的截止到最后保存时刻）记入其归属的日期
    const spans = (saved.studySpans || []).map((sp) => ({
      s: sp.s,
      e: sp.e === null ? (saved.savedAt || sp.s) : sp.e,
    }));
    if (spans.length) recordSpansToStats(spans);
    localStorage.removeItem(RUN_KEY);
    return;
  }
  segStudyMs = saved.segStudyMs || 0;
  runStart = saved.runStart || Date.now();
  breakEndsAt = saved.breakEndsAt || 0;
  breakTotalMs = saved.breakTotalMs || 0;
  breakCount = saved.breakCount || 0;
  goalHit = !!saved.goalHit;
  contMs = saved.contMs || 0;
  sitRemindCount = saved.sitRemindCount || 0;
  segStartTs = saved.segStartTs || Date.now();
  studySpans = (saved.studySpans || []).map((sp) => ({ s: sp.s, e: sp.e }));
  state = saved.state;   // setState(state) 由调用方执行
}

window.addEventListener("pagehide", () => saveRunState(true));
document.addEventListener("visibilitychange", () => { if (document.hidden) saveRunState(true); });

function updateButtons() {
  $("btnStart").hidden = state !== IDLE;
  $("btnPause").hidden = state !== STUDY;
  $("btnBreak").hidden = state !== STUDY;
  $("btnResume").hidden = state !== PAUSED;
  $("btnSkipBreak").hidden = state !== BREAK;
  $("btnEnd").hidden = state === IDLE;
  goalSelect.disabled = breakSelect.disabled = state === BREAK;
  syncTimerCard();
}

/* ---------- 渲染 ---------- */

const timerBarFill = $("timerBarFill");

function pad2(n) { return String(n).padStart(2, "0"); }

function fmtMS(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return `${pad2(m)}:${pad2(sec)}`;
  return `${Math.floor(m / 60)}:${pad2(m % 60)}:${pad2(sec)}`;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}

function render() {
  const now = Date.now();
  const timerEl = $("timer");
  const goalMs = Number(goalSelect.value) * 60000;

  if (state === BREAK) {
    const left = breakEndsAt - now;
    if (left <= 0) { endBreak(); return; }
    timerEl.textContent = fmtMS(left);
    timerBarFill.style.width = (Math.max(0, left / breakTotalMs) * 100).toFixed(1) + "%";
  } else {
    const el = studyElapsed();
    timerEl.textContent = fmtMS(el);
    if (state === STUDY && !goalHit && el >= goalMs) {
      goalHit = true;
      toast("达成专注目标！继续冲刺，或休息一下吧 ♪");
    }
    if (state === STUDY) {
      const cont = contMs + (Date.now() - runStart);
      if (cont >= SIT_REMIND_MS * (sitRemindCount + 1)) {
        sitRemindCount += 1;
        toast(`已经连续学习 ${Math.round(cont / 60000)} 分钟啦，休息一下吧 ♪`);
      }
    }
    timerBarFill.style.width = (Math.min(1, goalMs ? el / goalMs : 0) * 100).toFixed(1) + "%";
  }

  $("todayTotal").textContent = fmtClock(todayStats().ms + (state !== IDLE ? studyElapsed() : 0));
  // ↑ 暂停/休息时也要把本段已累计的时长算进"今日专注"（IDLE 时本段已结算入统计，不能再加，否则双倍）
  saveRunState();
}

setInterval(render, 250);

/* ---------- 今日统计（localStorage） ---------- */

const STATS_KEY = "mikuFocusStats_v1";

function loadStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; }
  catch { return {}; }
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayStats() {
  return loadStats()[todayKey()] || { ms: 0, sessions: 0 };
}

function recordSession() {
  return recordSpansToStats(studySpans);
}

function recordSpansToStats(spans) {
  // 把学习区间逐个按天拆分记账：暂停/休息造成的空档不属于任何一天
  const total = spans.reduce((a, sp) => a + (sp && sp.e > sp.s ? sp.e - sp.s : 0), 0);
  const all = loadStats();
  const dayKeyOf = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  for (const sp of spans) {
    if (!(sp.e > sp.s)) continue;
    let cursor = sp.s;
    let remaining = sp.e - sp.s;
    while (remaining > 0) {
      const dayEnd = new Date(cursor);
      dayEnd.setHours(24, 0, 0, 0);
      const span = Math.min(dayEnd.getTime() - cursor, remaining);
      const key = dayKeyOf(cursor);
      const b = all[key] || { ms: 0, sessions: 0 };
      b.ms += span;
      all[key] = b;
      cursor += span;
      remaining -= span;
    }
  }
  const t = all[todayKey()] || { ms: 0, sessions: 0 };
  if (total >= 60000) t.sessions += 1;   // "完成段数"记在结束当天
  all[todayKey()] = t;
  // 页面只用得到当天的统计，保留最近 60 天即可，防止键无限膨胀
  const cutoff = new Date(Date.now() - 60 * 86400000);
  const cutoffKey = `${cutoff.getFullYear()}-${pad2(cutoff.getMonth() + 1)}-${pad2(cutoff.getDate())}`;
  for (const k of Object.keys(all)) if (k < cutoffKey) delete all[k];
  localStorage.setItem(STATS_KEY, JSON.stringify(all));
  $("todaySessions").textContent = t.sessions;
  return total;
}

function sumStudySpans() {
  return studySpans.reduce((a, sp) => a + (sp && sp.e > sp.s ? sp.e - sp.s : 0), 0);
}

$("todaySessions").textContent = todayStats().sessions;

/* ---------- 动作 ---------- */

function startStudy() {
  segStudyMs = 0;
  breakCount = 0;
  goalHit = false;
  contMs = 0;
  sitRemindCount = 0;
  studySpans = [];
  runStart = Date.now();
  segStartTs = runStart;
  studySpans.push({ s: runStart, e: null });   // 打开学习区间
  setState(STUDY);
  resumeMusicForStudy();
}

function pauseStudy() {
  segStudyMs = studyElapsed();
  contMs += Date.now() - runStart;
  closeStudySpan();
  pauseMusicForStudy();
  setState(PAUSED);
}

function resumeStudy() {
  runStart = Date.now();
  openStudySpan();
  resumeMusicForStudy();
  setState(STUDY);
}

function startBreak() {
  segStudyMs = studyElapsed();
  closeStudySpan();
  pauseMusicForStudy();
  breakTotalMs = Number(breakSelect.value) * 60000;
  breakEndsAt = Date.now() + breakTotalMs;
  breakCount += 1;
  setState(BREAK);
}

function endBreak() {
  contMs = 0;
  sitRemindCount = 0;
  runStart = Date.now();
  openStudySpan();
  resumeMusicForStudy();
  setState(STUDY);
  toast("休息结束，回来继续加油！♪");
}

function skipBreak() { endBreak(); }

/* 学习区间的开合：openStudySpan/closeStudySpan 保证任何时刻至多一个未闭合区间 */
function openStudySpan(ts = Date.now()) {
  const last = studySpans[studySpans.length - 1];
  if (last && last.e === null) return;   // 已有未闭合区间，勿重复打开
  studySpans.push({ s: ts, e: null });
}

function closeStudySpan(ts = Date.now()) {
  const last = studySpans[studySpans.length - 1];
  if (last && last.e === null) last.e = ts;
}

function endSession() {
  closeStudySpan();            // 收口进行中的学习区间
  pauseMusicForStudy();        // 音乐渐变停止
  const total = sumStudySpans();
  segStudyMs = total;          // 冻结本段时长，弹窗背后保持显示
  recordSession();

  state = IDLE;
  document.body.dataset.state = IDLE;
  updateButtons();
  render();

  $("sumStudy").textContent = fmtMS(total);
  $("sumBreaks").textContent = breakCount;
  $("sumToday").textContent = fmtClock(todayStats().ms);
  $("summaryModal").hidden = false;
  window.dispatchEvent(new Event("miku-study-change"));
}

function resetToIdle() {
  $("summaryModal").hidden = true;
  segStudyMs = 0;
  breakCount = 0;
  goalHit = false;
  studySpans = [];
  setState(IDLE);
}

$("btnStart").addEventListener("click", startStudy);
$("btnPause").addEventListener("click", pauseStudy);
$("btnResume").addEventListener("click", resumeStudy);
$("btnBreak").addEventListener("click", startBreak);
$("btnSkipBreak").addEventListener("click", skipBreak);
$("btnEnd").addEventListener("click", endSession);
$("btnCloseSummary").addEventListener("click", resetToIdle);
$("summaryModal").addEventListener("click", (e) => { if (e.target === e.currentTarget) resetToIdle(); });

goalSelect.addEventListener("change", render);
breakSelect.addEventListener("change", render);

window.addEventListener("keydown", (e) => {
  if (!$("summaryModal").hidden) {
    if (e.code === "Enter") { e.preventDefault(); resetToIdle(); }
    return;
  }
  if (e.code === "KeyI" && !e.repeat) {        // 沉浸模式：保留时长，收起/唤出其余模块
    if (e.target.closest("input, select, textarea")) return;
    e.preventDefault();
    setImmersive(!immersive);
    return;
  }
  if (e.code !== "Space") return;
  if (e.target.closest("input, select, textarea, button")) return;
  e.preventDefault();
  if (state === IDLE) startStudy();
  else if (state === STUDY) pauseStudy();
  else if (state === PAUSED) resumeStudy();
});

/* ================= 沉浸模式（按 I 收起操作区与其他模块，时长常驻） ================= */

let immersive = false;
let immersiveSince = 0;

function setImmersive(on) {
  immersive = on;
  if (on) immersiveSince = Date.now();
  document.body.classList.toggle("immersive", on);
  syncTimerCard();
}

window.addEventListener("mousemove", () => {
  if (immersive && Date.now() - immersiveSince > 700) setImmersive(false);   // 留 0.7s 缓冲，防止按键时的手部抖动立刻取消
}, { passive: true });
window.addEventListener("pointerdown", () => {
  if (immersive && Date.now() - immersiveSince > 700) setImmersive(false);
}, { passive: true });

/* ================= 提示气泡 ================= */

let toastTimer = 0;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ================= 音乐播放器 ================= */

const audio = $("audio");
let tracks = [];   // { name, url, dur }
let cur = -1;

const btnPlay = $("btnPlay"), npName = $("npName");
const seekBar = $("seekBar"), timeCur = $("timeCur"), timeDur = $("timeDur");
const volBar = $("volBar"), volIcon = $("volIcon");

const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/></svg>`;

function fmtDur(sec) {
  if (!isFinite(sec)) return "--:--";
  return `${Math.floor(sec / 60)}:${pad2(Math.round(sec % 60))}`;
}

function renderPlaylist() {
  if (window.mikuRoom?.active) { window.mikuRoom.renderPlayer(); return; }
  const box = $("playlist");
  box.innerHTML = "";
  if (!tracks.length) {
    const li = document.createElement("li");
    li.className = "pl-empty";
    li.textContent = "播放列表是空的，导入几首喜欢的歌，和初音一起专注吧 ♪";
    box.appendChild(li);
    return;
  }
  tracks.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = "pl-row" + (i === cur ? " playing" : "");

    const idx = document.createElement("span");
    idx.className = i === cur ? "pl-eq" : "pl-idx";
    idx.textContent = i === cur ? "♪" : String(i + 1);

    const name = document.createElement("span");
    name.className = "pl-name";
    name.textContent = t.name;
    name.title = t.artist ? `${t.name} · ${t.artist}` : t.name;

    const dur = document.createElement("span");
    dur.className = "pl-dur";
    dur.textContent = (t.source === "netease" ? "网易云 · " : "") + (t.dur ? fmtDur(t.dur) : "--:--");

    const del = document.createElement("button");
    del.className = "pl-del";
    del.textContent = "✕";
    del.title = "移除";
    del.addEventListener("click", (e) => { e.stopPropagation(); removeTrack(i); });

    li.append(idx, name, dur, del);
    li.addEventListener("click", () => playIndex(i));
    box.appendChild(li);
  });
}

function playIndex(i) {
  if (window.mikuRoom?.active) return;
  if (!tracks[i]) return;
  if (tracks[i].requiresLogin && !window.mikuNetease?.loggedIn) { window.mikuNetease?.open(); toast("请先扫码登录网易云，再播放这首歌。"); return; }
  if (tracks[i].source === "netease" && location.protocol === "file:") { toast("网易云音乐需要通过学习房间服务打开页面。"); return; }
  cur = i;
  audio.src = tracks[i].url;
  const p = audio.play();
  if (p) p.catch(() => { /* 自动播放被拦截时保持就绪状态 */ });
  npName.textContent = tracks[i].name;
  seekBar.disabled = false;
  renderPlaylist();
}

function updatePlayBtn() {
  if (window.mikuRoom?.active) { window.mikuRoom.renderPlayer(); return; }
  btnPlay.innerHTML = audio.paused ? ICON_PLAY : ICON_PAUSE;
}

function nextTrack(manual = false) {
  if (window.mikuRoom?.active) return;
  if (!tracks.length) return;
  const mode = PLAY_MODES[playModeIdx].id;
  if (manual) { playIndex((cur + 1) % tracks.length); return; }   // 手动切歌永远按顺序，不受模式影响
  if (mode === "single") { playIndex(cur); return; }               // loop 属性一般已处理，这里兜底
  if (mode === "shuffle" && tracks.length > 1) {                   // 自然播完：随机（不重复上一首）
    let i;
    do { i = Math.floor(Math.random() * tracks.length); } while (i === cur);
    playIndex(i);
    return;
  }
  playIndex((cur + 1) % tracks.length);
}

function prevTrack() {
  if (!tracks.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  playIndex((cur - 1 + tracks.length) % tracks.length);
}

function removeTrack(i) {
  dbDelete(tracks[i]);
  if (tracks[i].url.startsWith("blob:")) URL.revokeObjectURL(tracks[i].url);
  tracks.splice(i, 1);
  saveOnlineLibrary();
  if (i === cur) {
    audio.pause();
    audio.src = "";
    cur = -1;
    npName.textContent = tracks.length ? "选择一首歌开始听吧" : "还没有导入音乐，点击右侧「＋」吧";
    seekBar.disabled = true;
    seekBar.value = 0;
    timeCur.textContent = "0:00";
    timeDur.textContent = "0:00";
    if (tracks.length) playIndex(Math.min(i, tracks.length - 1));
  } else if (i < cur) {
    cur -= 1;
  }
  renderPlaylist();
}

/* ---------- 歌单持久化（IndexedDB，不可用时自动退回仅本次会话） ---------- */

let db = null;
function openDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("mikuFocusDB", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function initLibrary() {
  db = await openDB();
  if (!db) return;
  try {
    const saved = await new Promise((res, rej) => {
      const r = db.transaction("tracks").objectStore("tracks").getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    saved.forEach((rec) => {
      const track = { name: rec.name, url: URL.createObjectURL(rec.blob), dur: rec.dur || null, blob: rec.blob, dbId: rec.id };
      tracks.push(track);
      probeDuration(track);
    });
    if (saved.length) {
      renderPlaylist();
      if (!window.mikuRoom?.active) {
        npName.textContent = "歌单已恢复，点播放按钮开始听 ♪";
        toast(`已恢复上次导入的 ${saved.length} 首音乐 ♪`);
      }
    }
  } catch { db = null; }
}

function dbSave(track) {
  if (track.source === "netease") { saveOnlineLibrary(); return; }
  if (!db) return;
  try {
    const r = db.transaction("tracks", "readwrite").objectStore("tracks")
      .add({ name: track.name, blob: track.blob, dur: null });
    r.onsuccess = () => { track.dbId = r.result; };
  } catch { /* 存储空间不足等情况：仅本次会话有效 */ }
}

function dbUpdateDur(track) {
  if (track.source === "netease") return;
  if (!db || track.dbId == null) return;
  try {
    db.transaction("tracks", "readwrite").objectStore("tracks")
      .put({ id: track.dbId, name: track.name, blob: track.blob, dur: track.dur });
  } catch {}
}

function dbDelete(track) {
  if (!db || track.dbId == null) return;
  try {
    db.transaction("tracks", "readwrite").objectStore("tracks").delete(track.dbId);
  } catch {}
}

function probeDuration(track) {
  const probe = new Audio();
  probe.preload = "metadata";
  probe.src = track.url;
  probe.onloadedmetadata = () => {
    track.dur = probe.duration;
    renderPlaylist();
    if (tracks[cur] === track) timeDur.textContent = fmtDur(probe.duration);
    dbUpdateDur(track);
  };
}

$("btnImport").addEventListener("click", () => window.mikuNetease ? window.mikuNetease.open() : $("fileInput").click());

function saveOnlineLibrary() {
  try { localStorage.setItem("mikuFocusNetease_v1", JSON.stringify(tracks.filter((t) => t.source === "netease" && !t.requiresLogin).map((t) => ({ id: t.neteaseId, name: t.name, artist: t.artist, duration: t.dur })))); } catch {}
}
function addOnlineTracks(items) {
  const existing = new Set(tracks.map((t) => t.neteaseId));
  const candidates = items.filter((t) => t.available && !existing.has(t.id));
  const selected = candidates.slice(0, Math.max(0, 200 - tracks.filter((t) => t.source === "netease").length));
  for (const t of selected) tracks.push({ source: "netease", neteaseId: t.id, requiresLogin: Boolean(t.requiresLogin), name: t.name, artist: t.artist, dur: t.duration, url: `/api/netease/audio/${t.id}` });
  saveOnlineLibrary(); renderPlaylist();
  return { added: selected.length, capacitySkipped: candidates.length - selected.length };
}
function clearAccountTracks() {
  const previous = tracks[cur];
  for (let i = tracks.length - 1; i >= 0; i--) if (tracks[i].requiresLogin) tracks.splice(i, 1);
  cur = previous ? tracks.indexOf(previous) : -1;
  if (previous?.requiresLogin && !window.mikuRoom?.active) {
    audio.pause(); audio.removeAttribute("src"); audio.load();
    npName.textContent = "导入喜欢的音乐"; seekBar.disabled = true; seekBar.value = 0;
    timeCur.textContent = timeDur.textContent = "0:00";
  }
  saveOnlineLibrary(); renderPlaylist();
}
function restoreOnlineLibrary() {
  if (location.protocol === "file:") return;
  try {
    const saved = JSON.parse(localStorage.getItem("mikuFocusNetease_v1") || "[]");
    if (Array.isArray(saved)) addOnlineTracks(saved.slice(0, 200).filter((t) => /^[1-9]\d{0,15}$/.test(String(t.id))).map((t) => ({ ...t, id: String(t.id), name: String(t.name || "网易云歌曲"), duration: Number(t.duration) || 0, available: true })));
  } catch {}
}

$("fileInput").addEventListener("change", (e) => {
  const files = [...e.target.files].filter(
    (f) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|flac|wav|ogg|opus|weba|webm)$/i.test(f.name)
  );
  e.target.value = "";
  if (!files.length) { toast("没有识别到音频文件哦"); return; }
  if (window.mikuRoom?.active) { window.mikuRoom.importFiles(files); return; }

  const firstNew = tracks.length;
  files.forEach((f) => {
    const track = { name: f.name.replace(/\.[^.]+$/, ""), url: URL.createObjectURL(f), dur: null, blob: f, dbId: null };
    tracks.push(track);
    dbSave(track);
    probeDuration(track);
  });

  renderPlaylist();
  toast(`已导入 ${files.length} 首音乐 ♪`);
  if (cur === -1) playIndex(firstNew);
});

btnPlay.addEventListener("click", () => {
  if (window.mikuRoom?.active) { window.mikuRoom.control("toggle"); return; }
  if (cur === -1) { if (tracks.length) playIndex(0); return; }
  if (audio.paused) {
    if (musicHeldByStudy) { musicHeldByStudy = false; setPlaybackVolume(userVolume); }   // 手动接管时立即恢复音量
    audio.play();
  } else {
    musicHeldByStudy = false;
    cancelMusicFade();
    audio.pause();
  }
});
$("btnNext").addEventListener("click", () => window.mikuRoom?.active ? window.mikuRoom.control("next") : nextTrack(true));
$("btnPrev").addEventListener("click", () => window.mikuRoom?.active ? window.mikuRoom.control("prev") : prevTrack());
$("btnList").addEventListener("click", () => $("playlist").classList.toggle("open"));

/* ---------- 播放模式（顺序循环 / 单曲循环 / 随机播放） ---------- */
/* 图标用内联 SVG 手绘（单色描边、继承按钮颜色），避免 Windows 把 emoji 渲染成彩色 */

const ICON_REPEAT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;

const ICON_REPEAT_ONE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15.5" font-size="8.5" font-weight="bold" fill="currentColor" stroke="none" text-anchor="middle" font-family="Segoe UI, sans-serif">1</text></svg>`;

const ICON_SHUFFLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`;

const PLAY_MODES = [
  { id: "order",   icon: ICON_REPEAT,     name: "顺序循环" },
  { id: "single",  icon: ICON_REPEAT_ONE, name: "单曲循环" },
  { id: "shuffle", icon: ICON_SHUFFLE,    name: "随机播放" },
];
let playModeIdx = Math.max(0, PLAY_MODES.findIndex((m) => m.id === localStorage.getItem("mikuFocusPlayMode")));

function applyPlayMode() {
  const m = PLAY_MODES[playModeIdx];
  audio.loop = m.id === "single";
  const btn = $("btnMode");
  btn.innerHTML = m.icon;
  btn.title = `播放模式：${m.name}（点击切换）`;
  btn.classList.toggle("active", m.id !== "order");
}

$("btnMode").addEventListener("click", () => {
  if (window.mikuRoom?.active) return;
  playModeIdx = (playModeIdx + 1) % PLAY_MODES.length;
  localStorage.setItem("mikuFocusPlayMode", PLAY_MODES[playModeIdx].id);
  applyPlayMode();
  toast(`播放模式：${PLAY_MODES[playModeIdx].name}`);
});
applyPlayMode();

audio.addEventListener("play", () => { updatePlayBtn(); renderPlaylist(); });
audio.addEventListener("pause", () => { updatePlayBtn(); renderPlaylist(); });
audio.addEventListener("ended", () => nextTrack(false));
audio.addEventListener("error", () => { if (!window.mikuRoom?.active && tracks[cur]?.source === "netease") { toast("这首网易云歌曲暂时无法播放，请检查登录权限或稍后重试。"); window.mikuNetease?.refreshAuth().catch(() => {}); } });
audio.addEventListener("loadedmetadata", () => { if (!window.mikuRoom?.active) timeDur.textContent = fmtDur(audio.duration); });
audio.addEventListener("timeupdate", () => {
  if (window.mikuRoom?.active) return;
  timeCur.textContent = fmtDur(audio.currentTime);
  if (isFinite(audio.duration) && audio.duration > 0 && !seekDragging) {
    seekBar.value = Math.round((audio.currentTime / audio.duration) * 1000);
  }
});

let seekDragging = false;
seekBar.addEventListener("input", () => { seekDragging = true; });
seekBar.addEventListener("change", () => {
  if (window.mikuRoom?.active) { window.mikuRoom.control("seek", Number(seekBar.value) / 1000); seekDragging = false; return; }
  if (isFinite(audio.duration)) audio.currentTime = (seekBar.value / 1000) * audio.duration;
  seekDragging = false;
});

/* 音量（图标为内联 SVG，与播放模式图标同一风格，避免 Windows 把 emoji 渲染成彩色） */
const ICON_VOL_MUTE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
const ICON_VOL_LOW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
const ICON_VOL_HIGH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;

let lastVol = 80; // 记住最近一次非零音量，取消静音时恢复
let userVolume = 0.8;         // 用户设定的目标音量（0–1）
let musicHeldByStudy = false; // 音乐因学习暂停/结束而被渐变停止中
let musicFadeTimer = 0;
function setPlaybackVolume(value) {
  if (!window.mikuRoom?.setLocalVolume(value)) audio.volume = value;
}
function getPlaybackVolume() {
  return window.mikuRoom?.getLocalVolume() ?? audio.volume;
}
function applyVolume(v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  userVolume = v / 100;
  volIcon.innerHTML = v == 0 ? ICON_VOL_MUTE : v < 45 ? ICON_VOL_LOW : ICON_VOL_HIGH;
  volBar.value = v;
  localStorage.setItem("mikuFocusVol", v);
  if (v > 0) lastVol = v;
  window.dispatchEvent(new Event("miku-volume-change"));
  if (musicHeldByStudy) return;   // 学习渐变接管期间只记目标值，不直接动音频
  cancelMusicFade();
  audio.muted = false;
  setPlaybackVolume(userVolume);
}

/* 音乐渐变：学习暂停/结束时缓降停止，恢复时淡入（避免生硬切断） */
function cancelMusicFade() { clearInterval(musicFadeTimer); musicFadeTimer = 0; }

function fadeMusicTo(target, ms, onDone) {
  cancelMusicFade();
  const from = getPlaybackVolume();
  const t0 = Date.now();
  musicFadeTimer = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / ms);
    setPlaybackVolume(from + (target - from) * k);
    if (k >= 1) { cancelMusicFade(); if (onDone) onDone(); }
  }, 50);
}

function pauseMusicForStudy() {
  if (window.mikuRoom?.active) return;            // 房间音乐不随个人计时暂停
  if (audio.paused && !musicHeldByStudy) return;   // 本来就没在放
  musicHeldByStudy = true;
  fadeMusicTo(0, 2500, () => audio.pause());
}

function resumeMusicForStudy() {
  if (window.mikuRoom?.active) return;
  if (!musicHeldByStudy) return;                   // 不是被学习停下的，不自动播放
  musicHeldByStudy = false;
  const p = audio.play();
  const done = () => fadeMusicTo(userVolume, 2500);
  if (p) p.then(done).catch(() => { setPlaybackVolume(userVolume); }); else done();
}
volBar.addEventListener("input", () => applyVolume(Number(volBar.value)));
volIcon.addEventListener("click", () => {
  applyVolume(audio.muted || getPlaybackVolume() == 0 ? lastVol : 0);
});
applyVolume(Number(localStorage.getItem("mikuFocusVol") ?? 80));

/* ================= 待办事项（左侧收纳栏） ================= */

let todos = (() => {
  try { return JSON.parse(localStorage.getItem("mikuFocusTodos_v1")) || []; }
  catch { return []; }
})();
let dragIdx = -1;

const todoWrapEl = $("todoWrap"), todoList = $("todoList"), todoInput = $("todoInput");

function saveTodos() { localStorage.setItem("mikuFocusTodos_v1", JSON.stringify(todos)); }

function updateTodoCounts() {
  const done = todos.filter((t) => t.done).length;
  $("todoCount").textContent = `${done}/${todos.length}`;
  const badge = $("todoBadge");
  badge.textContent = todos.length - done;
  badge.hidden = todos.length - done === 0;
}

function renderTodos() {
  todoList.innerHTML = "";
  if (!todos.length) {
    const li = document.createElement("li");
    li.className = "todo-empty";
    li.textContent = "暂无待办，添加一条吧";
    todoList.appendChild(li);
  } else {
    todos.forEach((t, i) => {
      const li = document.createElement("li");
      li.className = "todo-item" + (t.done ? " done" : "");
      li.draggable = true;

      const grip = document.createElement("span");
      grip.className = "todo-grip";
      grip.title = "拖动排序";
      grip.textContent = "⠿";

      const check = document.createElement("span");
      check.className = "todo-check";
      check.textContent = "✓";

      const text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = t.text;

      const del = document.createElement("button");
      del.className = "todo-del";
      del.textContent = "✕";
      del.title = "删除";
      del.addEventListener("click", (e) => { e.stopPropagation(); todos.splice(i, 1); saveTodos(); renderTodos(); });

      li.append(grip, check, text, del);
      li.addEventListener("click", (e) => {
        if (e.target.closest(".todo-grip") || e.target.closest(".todo-del")) return;
        todos[i].done = !todos[i].done;
        saveTodos();
        renderTodos();
      });

      li.addEventListener("dragstart", (e) => {
        dragIdx = i;
        li.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", String(i)); } catch {}
      });
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        li.classList.add("drag-over");
      });
      li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        li.classList.remove("drag-over");
        if (dragIdx < 0 || dragIdx === i) return;
        const [moved] = todos.splice(dragIdx, 1);
        todos.splice(i, 0, moved);
        saveTodos();
        renderTodos();
      });
      li.addEventListener("dragend", () => {
        dragIdx = -1;
        li.classList.remove("dragging");
        renderTodos();
      });

      todoList.appendChild(li);
    });
  }
  updateTodoCounts();
}

// 容器兜底：拖到列表下方空白处松手 = 移到末尾（落在条目上时由条目处理器先处理，
// 其 preventDefault 会让这里的容器处理直接跳过，避免重复移动）
todoList.addEventListener("dragover", (e) => {
  if (dragIdx < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
});
todoList.addEventListener("drop", (e) => {
  if (dragIdx < 0 || e.defaultPrevented) return;
  e.preventDefault();
  const [moved] = todos.splice(dragIdx, 1);
  todos.push(moved);
  saveTodos();
  renderTodos();
});

function addTodo() {
  const v = todoInput.value.trim();
  if (!v) return;
  todos.push({ text: v, done: false });
  todoInput.value = "";
  saveTodos();
  renderTodos();
}

$("btnTodoAdd").addEventListener("click", addTodo);
todoInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });

$("todoTab").addEventListener("click", () => {
  const open = todoWrapEl.classList.toggle("open");
  if (open) todoInput.focus();
});

renderTodos();

/* ================= 背景漂浮音符 ================= */

(function makeNotes() {
  const box = $("notes");
  const syms = ["♪", "♫", "♩", "♬"];
  for (let i = 0; i < 14; i++) {
    const s = document.createElement("span");
    s.className = "note";
    s.textContent = syms[i % syms.length];
    s.style.setProperty("--x", (Math.random() * 96 + 2).toFixed(1) + "%");
    s.style.setProperty("--s", (Math.random() * 16 + 14).toFixed(0) + "px");
    s.style.setProperty("--d", (Math.random() * 14 + 14).toFixed(1) + "s");
    s.style.setProperty("--delay", (-Math.random() * 28).toFixed(1) + "s");
    s.style.setProperty("--o", (Math.random() * 0.35 + 0.22).toFixed(2));
    s.style.setProperty("--sway", (Math.random() * 120 - 60).toFixed(0) + "px");
    box.appendChild(s);
  }
})();

/* ================= 浏览器全屏 ================= */

const fullscreenBtn = $("btnFullscreen");
const fullscreenIcon = $("fullscreenIcon");
const fullscreenLabel = $("fullscreenLabel");
const FULLSCREEN_ENTER_PATH = '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>';
const FULLSCREEN_EXIT_PATH = '<path d="M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3"/>';

function updateFullscreenButton() {
  const active = Boolean(document.fullscreenElement);
  const label = active ? "退出全屏" : "进入全屏";
  fullscreenLabel.textContent = label;
  fullscreenIcon.innerHTML = active ? FULLSCREEN_EXIT_PATH : FULLSCREEN_ENTER_PATH;
  fullscreenBtn.title = active ? "退出全屏（也可按 Esc）" : label;
  fullscreenBtn.setAttribute("aria-label", label);
  fullscreenBtn.setAttribute("aria-pressed", String(active));
}

fullscreenBtn.addEventListener("click", async () => {
  if (fullscreenBtn.disabled) return;
  fullscreenBtn.disabled = true;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (typeof document.documentElement.requestFullscreen === "function") {
      await document.documentElement.requestFullscreen();
    } else {
      toast("当前浏览器不支持页面全屏，请使用 Chrome 或 Edge 打开。");
    }
  } catch {
    toast("浏览器未允许全屏，请重新点击，或按 F11 进入浏览器全屏。");
  } finally {
    fullscreenBtn.disabled = false;
    updateFullscreenButton();
  }
});

document.addEventListener("fullscreenchange", updateFullscreenButton);
updateFullscreenButton();

/* ================= 启动 ================= */

restoreRunState();          // 恢复上次未结束的计时段（若有）
setState(state);
updatePlayBtn();
renderPlaylist();
initLibrary().finally(restoreOnlineLibrary);

// Minimal bridge for the optional room layer; personal data stays in this page.
window.mikuFocus = {
  getStudy: () => ({ status: state, elapsedMs: state === IDLE ? 0 : studyElapsed() }),
  getTrack: () => ({ name: tracks[cur]?.name || "房主还没有播放音乐", playing: !audio.paused && Boolean(tracks[cur]) }),
  getVolume: () => userVolume,
  setVolume: (value) => applyVolume(value * 100),
  addOnlineTracks,
  clearAccountTracks,
  restorePlayer: () => { npName.textContent = tracks[cur]?.name || "导入喜欢的音乐"; updatePlayBtn(); renderPlaylist(); applyPlayMode(); seekBar.disabled = cur < 0; },
};
window.addEventListener("miku-room-change", () => {
  // A fade started before entering a room must never pause everybody's music.
  cancelMusicFade();
  musicHeldByStudy = false;
  setPlaybackVolume(userVolume);
});
