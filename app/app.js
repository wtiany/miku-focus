/* 初音未来专注 · Miku Focus */
"use strict";

const $ = (id) => document.getElementById(id);

/* ================= 图片轮播 ================= */

/* 壁纸组：学习与休息共用同一组（素材全部来自用户自己的 Wallpaper Engine） */
const WALLPAPERS = [
  { src: "assets/images/miku_guitar_night.jpg", name: "吉他夜色" },
  { src: "assets/images/miku_ribbon.jpg", name: "缎带轻舞" },
  { src: "assets/images/miku_holiday.jpg", name: "假日时光" },
  { src: "assets/videos/miku_sea_color.mp4", name: "海色" },
  { src: "assets/videos/miku_moon_night.mp4", name: "月夜" },
];
const BUILTIN_WALLPAPERS = WALLPAPERS.slice();
let projectBackgrounds = Array.isArray(window.MikuCustomBackgrounds) ? window.MikuCustomBackgrounds.filter(item => item && /^[a-f0-9]{64}$/.test(item.id || "") && /^assets\/images\/custom-[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(item.src || "")) : [];
let browserBackgrounds = [], backgroundDatabase = null, backgroundCapability = null, backgroundSelectionVersion = 0;
WALLPAPERS.push(...projectBackgrounds);

const layerA = $("layerA"), layerB = $("layerB");
const isVideoSrc = (src) => /\.(mp4|webm|ogv|mov|m4v)$/i.test(src);
const BACKGROUND_KEY = "mikuFocusBackground_v1";
let savedBackground = {};
try { savedBackground = JSON.parse(localStorage.getItem(BACKGROUND_KEY)) || {}; } catch {}
const backgroundPrefs = { autoRotate: savedBackground.autoRotate !== false, videos: savedBackground.videos !== false, selectedSrc: savedBackground.selectedSrc, selectedId: savedBackground.selectedId };
let carouselList = WALLPAPERS.filter(item => backgroundPrefs.videos || !isVideoSrc(item.src));
let carouselIdx = 0;
let frontIsA = true;
let advanceTimer = 0;

function saveBackground() { try { localStorage.setItem(BACKGROUND_KEY, JSON.stringify(backgroundPrefs)); } catch {} }
function releaseStageVideo(vid) { vid.oncanplay = null; vid.onloadedmetadata = null; vid.pause(); if (vid.hasAttribute("src")) { vid.removeAttribute("src"); vid.load(); } vid.style.display = "none"; }

function setImage(idx) {
  backgroundSelectionVersion++;
  carouselIdx = (idx + carouselList.length) % carouselList.length;
  const item = carouselList[carouselIdx];
  const back = frontIsA ? layerB : layerA;
  const front = frontIsA ? layerA : layerB;
  const img = back.querySelector("img");
  const vid = back.querySelector("video");
  backgroundPrefs.selectedSrc = item.src;
  backgroundPrefs.selectedId = item.id || item.src;

  if (isVideoSrc(item.src)) {
    vid.onloadedmetadata = () => { if (vid.getAttribute("src") === item.src && back.classList.contains("show")) { item.dur = vid.duration; scheduleNext(); } };
    if (vid.getAttribute("src") !== item.src) {
      vid.src = item.src;
      vid.load();
    }
    img.style.display = "none";
    vid.style.display = "block";
    tryPlayStageVideo(vid);
  } else {
    releaseStageVideo(vid);
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
      if (fv) releaseStageVideo(fv);
    }
  }, 1400);

  scheduleNext();
  saveBackground(); renderBackgroundSettings();
}

/* 图片停留 30s；视频按自身时长播一遍再走（单个视频时 loop 属性保证无缝循环） */

function tryPlayStageVideo(vid) {
  if (!backgroundPrefs.videos || !vid.hasAttribute("src")) return;
  vid.play().catch(() => {
    vid.oncanplay = () => { if (backgroundPrefs.videos && vid.closest(".stage-layer").classList.contains("show")) vid.play().catch(() => {}); };
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
  if (!backgroundPrefs.autoRotate || carouselList.length < 2) { advanceTimer = 0; return; }
  const item = carouselList[carouselIdx];
  const ms = isVideoSrc(item.src) ? (item.dur ? Math.max(8000, item.dur * 1000) : 60000) : 30000;
  advanceTimer = setTimeout(() => setImage(carouselIdx + 1), ms);
}

$("carousel").addEventListener("click", () => { if (backgroundPrefs.autoRotate) setImage(carouselIdx + 1); });
function renderBackgroundSettings() {
  document.body.classList.toggle("static-background", !backgroundPrefs.videos);
  $("backgroundRotate").checked = backgroundPrefs.autoRotate;
  $("backgroundStatic").checked = !backgroundPrefs.videos;
  $("carousel").title = backgroundPrefs.autoRotate ? "点击切换背景" : "背景已固定，可在背景设置中更换";
  for (const button of $("backgroundChoices").children) {
    button.setAttribute("aria-pressed", String(button.dataset.src === backgroundPrefs.selectedSrc));
    button.disabled = !backgroundPrefs.videos && isVideoSrc(button.dataset.src);
  }
  const current = WALLPAPERS.find(item => item.src === backgroundPrefs.selectedSrc);
  $("backgroundStatus").textContent = `${backgroundPrefs.autoRotate ? "自动轮换" : "已固定"} · ${current?.name || ""}${backgroundPrefs.videos ? "" : " · 省性能模式"}。设置已自动保存。`;
}
function renderBackgroundChoices() {
$("backgroundChoices").replaceChildren();
for (const item of WALLPAPERS) {
  const button = document.createElement("button"); button.type = "button"; button.className = "background-choice"; button.dataset.src = item.src;
  const preview = document.createElement("span"); preview.className = "background-preview";
  if (isVideoSrc(item.src)) { preview.classList.add("background-video-preview"); preview.textContent = item.name; }
  else { const img = document.createElement("img"); img.src = item.src; img.alt = ""; img.loading = "lazy"; preview.append(img); }
  const name = document.createElement("strong"); name.textContent = item.name;
  const kind = document.createElement("small"); kind.textContent = item.browserOnly ? "本浏览器图片" : item.id ? "自选图片" : isVideoSrc(item.src) ? "动态视频" : "静态插画";
  button.append(preview, name, kind);
  button.addEventListener("click", () => { backgroundPrefs.autoRotate = false; setImage(carouselList.indexOf(item)); });
  $("backgroundChoices").append(button);
}
renderBackgroundSettings();
}
renderBackgroundChoices();
$("backgroundRotate").addEventListener("change", e => { backgroundPrefs.autoRotate = e.target.checked; saveBackground(); scheduleNext(); renderBackgroundSettings(); });
$("backgroundStatic").addEventListener("change", e => {
  backgroundPrefs.videos = !e.target.checked;
  if (!backgroundPrefs.videos) document.querySelectorAll(".stage-layer video").forEach(releaseStageVideo);
  carouselList = WALLPAPERS.filter(item => backgroundPrefs.videos || !isVideoSrc(item.src));
  setImage(Math.max(0, carouselList.findIndex(item => item.src === backgroundPrefs.selectedSrc)));
});
let backgroundReturnFocus = null;
function closeBackground() { $("backgroundModal").hidden = true; backgroundReturnFocus?.focus(); }
$("btnBackground").addEventListener("click", () => { backgroundReturnFocus = document.activeElement; $("backgroundModal").hidden = false; $("backgroundClose").focus(); });
$("backgroundClose").addEventListener("click", closeBackground);
$("backgroundModal").addEventListener("click", e => { if (e.target === e.currentTarget) closeBackground(); });
$("backgroundModal").addEventListener("keydown", e => {
  e.stopPropagation();
  if (e.key === "Escape") { e.preventDefault(); closeBackground(); }
  if (e.key === "Tab") {
    const items = [...e.currentTarget.querySelectorAll("button:not(:disabled), input:not(:disabled)")].filter(el => el.getClientRects().length);
    if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
  }
});
setImage(Math.max(0, carouselList.findIndex(item => item.src === backgroundPrefs.selectedSrc)));
const initialBackgroundVersion=backgroundSelectionVersion;
function rebuildCustomBackgrounds(preferredId) {
  const unique=new Map();for(const item of [...projectBackgrounds,...browserBackgrounds]) if(!unique.has(item.id)) unique.set(item.id,item);
  WALLPAPERS.splice(0,WALLPAPERS.length,...BUILTIN_WALLPAPERS,...unique.values());
  carouselList=WALLPAPERS.filter(item=>backgroundPrefs.videos || !isVideoSrc(item.src));
  renderBackgroundChoices();
  setImage(Math.max(0,carouselList.findIndex(item=>(item.id || item.src)===(preferredId || backgroundPrefs.selectedId))));
}
function openBackgroundDB() {
  return new Promise(resolve=>{try {const req=indexedDB.open("mikuFocusBackgrounds",1);req.onupgradeneeded=()=>req.result.createObjectStore("images",{keyPath:"id"});req.onsuccess=()=>resolve(req.result);req.onerror=req.onblocked=()=>resolve(null);}catch{resolve(null);}});
}
async function backgroundServerInfo() {
  const response=await fetch("/api/backgrounds",{cache:"no-store",signal:AbortSignal.timeout(10000)});
  if(!response.ok) throw new Error("背景服务未就绪，请重启服务后刷新页面。");
  const data=await response.json();if(!Array.isArray(data.items)) throw new Error("背景服务返回异常，请刷新重试。");
  backgroundCapability=data;return data;
}
function renderBackgroundImportHint() {
  $("backgroundImportHint").textContent=location.protocol==="file:" ? "离线导入保存在本浏览器；要复制到项目文件夹，请通过“启动学习房间.cmd”打开。" : backgroundCapability?.canUpload ? "图片复制到 app/assets/images，随项目保存与分享。支持 JPG、PNG、WebP、GIF，单张最多 20 MB。" : !crypto.subtle ? "请通过本机 localhost 或 HTTPS 网址添加图片。" : "图片保存在当前浏览器；复制进项目需要在运行服务的电脑本机操作。";
}
const backgroundReady=(async()=>{
  backgroundDatabase=await openBackgroundDB();
  if(backgroundDatabase) try {
    const records=await new Promise((resolve,reject)=>{const req=backgroundDatabase.transaction("images").objectStore("images").getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    browserBackgrounds=records.filter(r=>r.blob instanceof Blob && /^[a-f0-9]{64}$/.test(r.id)).map(r=>({id:r.id,name:r.name,src:URL.createObjectURL(r.blob),browserOnly:true}));
  }catch{}
  if(location.protocol!=="file:") try {projectBackgrounds=(await backgroundServerInfo()).items;}catch(err){$("backgroundImportStatus").textContent=err.message;}
  if(projectBackgrounds.length || browserBackgrounds.length) rebuildCustomBackgrounds(backgroundSelectionVersion===initialBackgroundVersion ? savedBackground.selectedId || savedBackground.selectedSrc : backgroundPrefs.selectedId);
  renderBackgroundImportHint();
})();
$("backgroundAdd").addEventListener("click",()=>$("backgroundInput").click());
$("backgroundInput").addEventListener("change",async e=>{
  const files=[...e.target.files];e.target.value="";if(!files.length) return;
  $("backgroundAdd").disabled=true;$("backgroundImportStatus").textContent="正在添加背景图片…";
  let added=0,duplicates=0,firstId=null;const failures=[];
  try {
    await backgroundReady;
    if(location.protocol!=="file:") await backgroundServerInfo();
    for(const file of files) try {
      if(!/\.(jpe?g|png|webp|gif)$/i.test(file.name) || !file.size || file.size>20*1024*1024) throw new Error(`${file.name}：请选择 20 MB 内的 JPG、PNG、WebP 或 GIF。`);
      const preview=URL.createObjectURL(file);
      try {await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve();img.onerror=()=>reject(new Error(`${file.name}：图片无法读取。`));img.src=preview;});} finally {URL.revokeObjectURL(preview);}
      if(backgroundCapability?.canUpload && location.protocol!=="file:") {
        let response=await fetch("/api/backgrounds",{method:"POST",headers:{"Content-Type":file.type || "application/octet-stream","X-File-Name":encodeURIComponent(file.name),"X-Background-Token":backgroundCapability.token},body:file});
        if(response.status===403) {await backgroundServerInfo();if(!backgroundCapability.canUpload) throw new Error("请在运行服务的电脑本机添加背景。");response=await fetch("/api/backgrounds",{method:"POST",headers:{"Content-Type":file.type || "application/octet-stream","X-File-Name":encodeURIComponent(file.name),"X-Background-Token":backgroundCapability.token},body:file});}
        const result=await response.json();if(!response.ok) throw new Error(result.error || "背景保存失败。");
        if(!projectBackgrounds.some(item=>item.id===result.item.id)) projectBackgrounds.push(result.item);
        result.added?added++:duplicates++;firstId ||= result.item.id;
      } else {
        if(!crypto.subtle) throw new Error("请通过本机 localhost 或 HTTPS 网址添加图片。");
        if(!backgroundDatabase) throw new Error("浏览器无法保存背景，请通过本机服务打开后重试。");
        const id=[...new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))].map(b=>b.toString(16).padStart(2,"0")).join("");
        if([...projectBackgrounds,...browserBackgrounds].some(item=>item.id===id)) {duplicates++;firstId ||= id;continue;}
        if(browserBackgrounds.length>=100) throw new Error("当前浏览器最多保存 100 张自选背景。");
        const name=file.name.replace(/\.[^.]+$/,"").slice(0,80);
        await new Promise((resolve,reject)=>{const tx=backgroundDatabase.transaction("images","readwrite");tx.objectStore("images").put({id,name,blob:file});tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(new Error("浏览器存储不足，图片未保存。"));});
        browserBackgrounds.push({id,name,src:URL.createObjectURL(file),browserOnly:true});added++;firstId ||= id;
      }
    } catch(err) {failures.push(err.message);}
    if(firstId) {backgroundPrefs.autoRotate=true;rebuildCustomBackgrounds(firstId);}
    $("backgroundImportStatus").textContent=[added?`已${backgroundCapability?.canUpload && location.protocol!=="file:"?"复制到背景文件夹并添加":"保存到本浏览器并添加"} ${added} 张，已开启轮播。`:"",duplicates?`${duplicates} 张已存在，未重复添加。`:"",...failures].filter(Boolean).join(" ");
  }catch(err){$("backgroundImportStatus").textContent=err.message || "添加失败，请重试。";}
  finally {$("backgroundAdd").disabled=false;renderBackgroundImportHint();}
});

/* ================= 计时状态机 ================= */

const IDLE = "idle", STUDY = "study", PAUSED = "paused", BREAK = "break";
let state = IDLE;
let selectedTaskId = "", activeTask = null, focusRunId = "";
try { selectedTaskId = localStorage.getItem("mikuFocusSelectedTask_v1") || ""; } catch {}

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
    studySpans, savedAt: now, task: activeTask, runId: focusRunId,
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
    creditTaskSession(saved.runId || `legacy-${saved.segStartTs || saved.savedAt}`, saved.task, spans.reduce((ms, sp) => ms + Math.max(0, sp.e - sp.s), 0));
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
  focusRunId = saved.runId || MikuPersonal.makeId();
  activeTask = saved.task?.id ? { id: String(saved.task.id), text: String(saved.task.text || "关联任务") } : null;
  if (activeTask) selectedTaskId = activeTask.id;
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
  renderTaskPicker();
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
  renderTaskProgress();
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
  if (state !== IDLE) return;
  const task = todos.find(t => t.id === selectedTaskId && !t.done);
  activeTask = task ? { id: task.id, text: task.text } : null;
  focusRunId = MikuPersonal.makeId();
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
  renderTodos();
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
  if (state === IDLE) return;
  closeStudySpan();            // 收口进行中的学习区间
  pauseMusicForStudy();        // 音乐渐变停止
  const total = sumStudySpans();
  segStudyMs = total;          // 冻结本段时长，弹窗背后保持显示
  creditTaskSession(focusRunId, activeTask, total);
  recordSession();

  state = IDLE;
  document.body.dataset.state = IDLE;
  updateButtons();
  render();
  renderTodos();

  $("sumStudy").textContent = fmtMS(total);
  $("sumBreaks").textContent = breakCount;
  $("sumToday").textContent = fmtClock(todayStats().ms);
  $("sumTaskDetails").hidden = !activeTask;
  $("sumTaskName").textContent = activeTask?.text || "";
  $("sumTaskTotal").textContent = fmtClock(activeTask ? taskTotal(activeTask.id) : 0);
  $("summaryModal").hidden = false;
  window.dispatchEvent(new Event("miku-study-change"));
}

function resetToIdle() {
  $("summaryModal").hidden = true;
  segStudyMs = 0;
  breakCount = 0;
  goalHit = false;
  studySpans = [];
  activeTask = null; focusRunId = "";
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
let tracks = [];   // 当前播放队列，歌曲对象由音乐库持有。
let cur = -1;
const MUSIC_LIBRARY_KEY = "mikuFocusMusicLibrary_v2", PLAY_QUEUE_KEY = "mikuFocusPlayQueue_v1";
let musicLibrary = new MikuMusic.MusicLibrary();
let selectedLibraryGroup = "local", libraryPreviousFocus = null, personalFileImport = false, libraryDeletion = null, libraryDeleting = false;
function readMusicStorage(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function saveMusicLibrary() { try { localStorage.setItem(MUSIC_LIBRARY_KEY, JSON.stringify(musicLibrary.serialize())); } catch { toast("音乐库暂时无法保存，当前导入仅本次有效。"); } }
function savePlayQueue() { try { localStorage.setItem(PLAY_QUEUE_KEY, JSON.stringify(musicLibrary.queueIds(tracks))); } catch {} }

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
  const scroll = box.scrollTop;
  box.innerHTML = "";
  const head = document.createElement("li"); head.className = "pl-head";
  const title = document.createElement("span"); title.textContent = `播放列表 · ${tracks.length} 首`;
  const clear = document.createElement("button"); clear.type = "button"; clear.className = "pl-clear"; clear.textContent = "清空列表"; clear.disabled = !tracks.length;
  clear.addEventListener("click", () => { tracks = []; resetSoloPlayer(); savePlayQueue(); renderPlaylist(); renderMusicLibrary(); });
  head.append(title, clear); box.append(head);
  if (!tracks.length) {
    const li = document.createElement("li");
    li.className = "pl-empty";
    li.textContent = "还没有待播放的歌曲，去音乐库挑选吧 ♪";
    const browse = document.createElement("button"); browse.type = "button"; browse.className = "pl-browse"; browse.textContent = "打开音乐库"; browse.addEventListener("click", () => openMusicLibrary()); li.append(browse);
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
    del.title = "从播放列表移除（保留在音乐库）";
    del.setAttribute("aria-label", `从播放列表移除 ${t.name}`);
    del.addEventListener("click", (e) => { e.stopPropagation(); removeTrack(i); });

    li.append(idx, name, dur, del);
    li.addEventListener("click", () => playIndex(i));
    box.appendChild(li);
  });
  box.scrollTop = scroll;
}

function playIndex(i) {
  if (window.mikuRoom?.active) return;
  if (!tracks[i]) return;
  if (tracks[i].requiresLogin && !window.mikuNetease?.loggedIn) { window.mikuNetease?.open(); toast("请先扫码登录网易云，再播放这首歌。"); return; }
  if (tracks[i].source === "netease" && location.protocol === "file:") { toast("网易云音乐需要通过学习房间服务打开页面。"); return; }
  cancelMusicFade(); musicHeldByStudy = false; setPlaybackVolume(userVolume);
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
  tracks.splice(i, 1);
  savePlayQueue();
  if (i === cur) {
    resetSoloPlayer();
    if (tracks.length) playIndex(Math.min(i, tracks.length - 1));
  } else if (i < cur) {
    cur -= 1;
  }
  renderPlaylist();
  renderMusicLibrary();
}

function resetSoloPlayer() {
  cancelMusicFade(); musicHeldByStudy = false; cur = -1;
  audio.pause(); audio.removeAttribute("src"); audio.load(); setPlaybackVolume(userVolume);
  npName.textContent = tracks.length ? "选择一首歌开始听吧" : "从音乐库选择喜欢的音乐";
  seekBar.disabled = true; seekBar.value = 0; timeCur.textContent = timeDur.textContent = "0:00"; updatePlayBtn();
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
  const savedCatalog = readMusicStorage(MUSIC_LIBRARY_KEY);
  try { musicLibrary = new MikuMusic.MusicLibrary(savedCatalog); } catch { musicLibrary = new MikuMusic.MusicLibrary(); }
  db = await openDB();
  if (db) try {
    const saved = await new Promise((res, rej) => {
      const r = db.transaction("tracks").objectStore("tracks").getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    saved.forEach((rec) => {
      if (!(rec.blob instanceof Blob)) return;
      const track = { id: rec.libraryId || `local:${rec.id}`, source: "local", name: rec.name, url: URL.createObjectURL(rec.blob), dur: rec.dur || null, blob: rec.blob, dbId: rec.id, fingerprint: rec.fingerprint || (rec.blob.name ? JSON.stringify([rec.blob.name, rec.blob.size, rec.blob.lastModified]) : "") };
      musicLibrary.addLocal(track);
      if (!track.dur) probeDuration(track);
    });
  } catch { db = null; }
  // 旧版本把收藏直接当作队列；首次升级保留原队列，之后只恢复明确保存的队列。
  const migrating = savedCatalog?.version !== 2;
  if (migrating) {
    const legacy = readMusicStorage("mikuFocusNetease_v1");
    if (Array.isArray(legacy) && legacy.length) musicLibrary.importNetease({ id: "legacy", name: "以前导入的网易云音乐", tracks: legacy.map(t => ({ ...t, available: true, requiresLogin: false })) });
  }
  const savedQueue = readMusicStorage(PLAY_QUEUE_KEY);
  tracks = savedQueue ? musicLibrary.restoreQueue(savedQueue) : migrating ? [...musicLibrary.songs.values()] : [];
  saveMusicLibrary(); savePlayQueue(); renderPlaylist(); renderMusicLibrary();
  if (!window.mikuRoom?.active && tracks.length) npName.textContent = "播放列表已恢复，点击播放开始听 ♪";
}

function localRecord(track) { return { name: track.name, blob: track.blob, dur: track.dur, libraryId: track.id, fingerprint: track.fingerprint }; }
async function dbSave(track) {
  if (!db) return false;
  return new Promise(resolve => {
    try {
      const tx = db.transaction("tracks", "readwrite"), r = tx.objectStore("tracks").add(localRecord(track));
      r.onsuccess = () => { track.dbId = r.result; };
      tx.oncomplete = () => resolve(true); tx.onerror = tx.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
}

function dbUpdateDur(track) {
  if (track.source === "netease") return;
  if (!db || track.dbId == null || track.deleting || musicLibrary.songs.get(track.id) !== track) return;
  try {
    db.transaction("tracks", "readwrite").objectStore("tracks")
      .put({ ...localRecord(track), id: track.dbId });
  } catch {}
}

function probeDuration(track) {
  const probe = new Audio();
  probe.preload = "metadata";
  const release = () => { probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute("src"); probe.load(); };
  probe.onloadedmetadata = () => {
    track.dur = probe.duration;
    renderPlaylist();
    if (tracks[cur] === track) timeDur.textContent = fmtDur(probe.duration);
    dbUpdateDur(track);
    release();
  };
  probe.onerror = release; probe.src = track.url;
}

$("btnImport").addEventListener("click", () => window.mikuNetease ? window.mikuNetease.open() : $("fileInput").click());

async function addOnlineTracks(items, playlist = {}) {
  await libraryReady;
  const result = musicLibrary.importNetease({ ...playlist, tracks: items });
  saveMusicLibrary(); savePlayQueue(); renderPlaylist(); renderMusicLibrary();
  return result;
}
function clearAccountTracks() {
  const previous = tracks[cur];
  if (previous?.requiresLogin && !window.mikuRoom?.active) resetSoloPlayer();
  renderPlaylist(); renderMusicLibrary();
}

$("fileInput").addEventListener("change", async (e) => {
  const personal = personalFileImport; personalFileImport = false;
  const files = [...e.target.files].filter(
    (f) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|flac|wav|ogg|opus|weba|webm)$/i.test(f.name)
  );
  e.target.value = "";
  if (!files.length) { toast("没有识别到音频文件哦"); return; }
  if (window.mikuRoom?.active && !personal) { window.mikuRoom.importFiles(files); return; }
  await libraryReady;
  let added = 0, notSaved = 0;
  for (const f of files) {
    const fingerprint = JSON.stringify([f.name, f.size, f.lastModified]);
    if (musicLibrary.groupSongs("local").some(t => t.fingerprint === fingerprint)) continue;
    const track = { id: `local:${MikuPersonal.makeId()}`, source: "local", name: f.name.replace(/\.[^.]+$/, ""), url: URL.createObjectURL(f), dur: null, blob: f, dbId: null, fingerprint };
    musicLibrary.addLocal(track); added++;
    if (!await dbSave(track)) notSaved++;
    probeDuration(track);
  }
  saveMusicLibrary(); openMusicLibrary("local");
  toast(notSaved ? `已导入 ${added} 首，其中 ${notSaved} 首暂时无法保存，刷新后需重新导入。` : added ? `已保存 ${added} 首到「本地导入」，选择整张播放或单首加入列表 ♪` : "这些本地歌曲已在音乐库中。");
});
$("fileInput").addEventListener("cancel", () => { personalFileImport = false; });

/* ---------- 来源歌单管理，与当前队列相互独立 ---------- */
function renderMusicLibrary() {
  const mask = $("musicLibraryModal"); if (mask.hidden) return;
  if (!musicLibrary.group(selectedLibraryGroup)) selectedLibraryGroup = "local";
  const focused = document.activeElement, focusGroup = focused?.dataset.groupId, focusSong = focused?.dataset.songId;
  const groups = $("libraryGroups"); groups.replaceChildren();
  for (const group of musicLibrary.groups) {
    const button = document.createElement("button"); button.type = "button"; button.className = "library-group"; button.dataset.groupId = group.id;
    button.setAttribute("aria-pressed", String(group.id === selectedLibraryGroup));
    const icon = document.createElement("span"); icon.className = "library-group-icon"; icon.textContent = group.source === "local" ? "♫" : "♪"; icon.setAttribute("aria-hidden", "true");
    const detail = document.createElement("span"); detail.className = "library-group-detail";
    const name = document.createElement("strong"); name.textContent = group.name; name.title = group.name;
    const count = document.createElement("small"); count.textContent = `${group.songIds.length} 首 · ${group.source === "local" ? "本地文件" : "网易云"}`;
    detail.append(name, count); button.append(icon, detail);
    button.addEventListener("click", () => { cancelLibraryDeletion(); selectedLibraryGroup = group.id; $("librarySongs").scrollTop = 0; renderMusicLibrary(); }); groups.append(button);
  }
  const group = musicLibrary.group(selectedLibraryGroup), songs = musicLibrary.groupSongs(group.id), inRoom = Boolean(window.mikuRoom?.active);
  $("librarySource").textContent = group.source === "local" ? "LOCAL COLLECTION" : "NETEASE PLAYLIST";
  $("libraryGroupName").textContent = group.name;
  const query = $("librarySearch").value.normalize("NFKC").trim().toLowerCase(), terms = query.split(/\s+/).filter(Boolean);
  const matches = songs.map((song, index) => ({ song, index })).filter(({ song }) => {
    const text = `${song.name} ${song.artist || ""}`.normalize("NFKC").toLowerCase();
    return terms.every(term => text.includes(term));
  });
  $("librarySearchClear").disabled = !$("librarySearch").value;
  $("libraryGroupCount").textContent = `${query ? `找到 ${matches.length} 首 / 共 ${songs.length} 首` : `${songs.length} 首歌曲`}${songs.some(t => t.requiresLogin) ? " · 含需要账号权限的歌曲" : ""}`;
  $("libraryPlayAll").disabled = !songs.length || inRoom;
  $("libraryDeleteGroup").textContent = group.source === "local" ? "清空本地导入" : "删除歌单";
  $("libraryDeleteGroup").disabled = libraryDeleting || (group.source === "local" && !songs.length);
  $("libraryNote").textContent = inRoom ? "这是你的个人音乐库，离开房间后可加入个人播放列表。房间音乐请使用房间内的导入按钮。" : query ? "当前仅筛选显示；播放整张歌单仍会使用全部歌曲，并替换底部播放列表。" : "导入只保存到音乐库；播放整张歌单会替换底部播放列表。";
  const box = $("librarySongs"), scroll = box.scrollTop; box.replaceChildren();
  if (!matches.length) { const empty = document.createElement("li"); empty.className = "library-empty"; empty.textContent = !songs.length ? "这里还没有歌曲，先导入喜欢的音乐吧。" : "没有找到匹配的歌曲，试试其他歌名或歌手。"; box.append(empty); }
  const queued = new Set(tracks.map(t => t.id));
  matches.forEach(({ song, index }) => {
    const row = document.createElement("li"); row.className = "library-song"; row.dataset.id = song.id;
    const num = document.createElement("span"); num.className = "library-song-index"; num.textContent = String(index + 1).padStart(2, "0");
    const detail = document.createElement("div"); detail.className = "library-song-detail";
    const name = document.createElement("strong"); name.textContent = song.name; name.title = song.name;
    const artist = document.createElement("span"); artist.textContent = song.artist || "本地音频"; if (song.requiresLogin) artist.textContent += window.mikuNetease?.loggedIn ? " · 按账号权限播放" : " · 需要登录";
    detail.append(name, artist);
    const duration = document.createElement("span"); duration.className = "library-song-duration"; duration.textContent = song.dur ? fmtDur(song.dur) : "--:--";
    const add = document.createElement("button"); add.type = "button"; add.className = "library-song-add"; add.dataset.songId = song.id;
    add.textContent = queued.has(song.id) ? "从列表移除" : "＋ 加入列表"; add.disabled = inRoom;
    add.dataset.queued = String(queued.has(song.id));
    add.title = queued.has(song.id) ? "仅从播放列表移除，保留音乐库收藏" : "追加到播放列表，保留当前播放进度";
    add.setAttribute("aria-label", `${queued.has(song.id) ? "从播放列表移除" : "加入播放列表"}：${song.name}`);
    add.addEventListener("click", () => {
      if (window.mikuRoom?.active) return;
      const position = tracks.findIndex(t => t.id === song.id);
      if (position >= 0) removeTrack(position);
      else { tracks.push(song); savePlayQueue(); renderPlaylist(); renderMusicLibrary(); }
      $("libraryNote").textContent = `已将「${song.name}」${position >= 0 ? "从播放列表移除，音乐库仍保留" : "加入播放列表"} · 共 ${tracks.length} 首`;
    });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "library-song-delete"; remove.title = "从此歌单移除"; remove.setAttribute("aria-label", `从此歌单移除：${song.name}`); remove.disabled = libraryDeleting;
    remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
    remove.addEventListener("click", () => askLibraryDeletion(song.id));
    row.append(num, detail, duration, add, remove); box.append(row);
  });
  box.scrollTop = scroll;
  if (focusGroup) [...groups.children].find(e => e.dataset.groupId === focusGroup)?.focus({ preventScroll: true });
  if (focusSong) {
    const button = [...box.querySelectorAll("button")].find(e => e.dataset.songId === focusSong);
    (button && !button.disabled ? button : $("libraryPlayAll"))?.focus({ preventScroll: true });
  }
}
async function openMusicLibrary(groupId) {
  await libraryReady;
  if (groupId) selectedLibraryGroup = groupId;
  $("librarySearch").value = "";
  cancelLibraryDeletion();
  libraryPreviousFocus = document.activeElement; $("playlist").classList.remove("open");
  $("musicLibraryModal").hidden = false; renderMusicLibrary(); $("musicLibraryClose").focus();
}
function closeMusicLibrary() {
  cancelLibraryDeletion();
  $("musicLibraryModal").hidden = true;
  (libraryPreviousFocus?.getClientRects().length ? libraryPreviousFocus : $("btnLibrary"))?.focus();
}
function pickPersonalFiles() { personalFileImport = true; $("fileInput").click(); }
$("btnLibrary").addEventListener("click", () => openMusicLibrary());
$("musicLibraryClose").addEventListener("click", closeMusicLibrary);
$("libraryImportLocal").addEventListener("click", pickPersonalFiles);
$("libraryImportNetease").addEventListener("click", () => { closeMusicLibrary(); window.mikuNetease?.open({ libraryOnly: true }); });
function updateLibrarySearch() { cancelLibraryDeletion(); $("librarySongs").scrollTop = 0; renderMusicLibrary(); }
$("librarySearch").addEventListener("input", e => { if (!e.isComposing) updateLibrarySearch(); });
$("librarySearch").addEventListener("compositionend", updateLibrarySearch);
$("librarySearchClear").addEventListener("click", () => { $("librarySearch").value = ""; $("librarySearch").focus(); updateLibrarySearch(); });
function cancelLibraryDeletion() { if (libraryDeleting) return; libraryDeletion = null; $("libraryDeleteConfirm").hidden = true; }
function askLibraryDeletion(songId) {
  if (libraryDeleting) return;
  const group = musicLibrary.group(selectedLibraryGroup), song = songId ? musicLibrary.songs.get(songId) : null;
  libraryDeletion = { groupId: group.id, songId };
  const target = song ? `从「${group.name}」移除「${song.name}」` : group.source === "local" ? "清空本地导入" : `删除「${group.name}」`;
  $("libraryDeleteMessage").textContent = `${target}？没有其他歌单收藏的歌曲，也会从个人播放列表移除。${group.source === "local" ? "只删除本页保存的音频副本，电脑原文件保留。" : "网易云账号里的原歌单不受影响。"}`;
  $("libraryDeleteConfirm").hidden = false; $("libraryCancelDelete").focus();
}
async function deleteLocalRecords(songs) {
  const records = songs.filter(t => t.dbId != null); if (!records.length) return;
  if (!db) throw new Error("本地存储暂时无法访问，请刷新后重试。");
  await new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    for (const song of records) tx.objectStore("tracks").delete(song.dbId);
    tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(new Error("未能删除本地副本，请稍后重试。"));
  });
}
$("libraryDeleteGroup").addEventListener("click", () => askLibraryDeletion());
$("libraryCancelDelete").addEventListener("click", () => { cancelLibraryDeletion(); $("libraryDeleteGroup").focus(); });
$("libraryConfirmDelete").addEventListener("click", async () => {
  if (!libraryDeletion || libraryDeleting) return;
  const action = libraryDeletion;
  const candidates = musicLibrary.groupSongs(action.groupId).filter(t => !action.songId || t.id === action.songId);
  for (const song of candidates) song.deleting = true;
  libraryDeleting = true; $("libraryConfirmDelete").disabled = $("libraryCancelDelete").disabled = true;
  try {
    await deleteLocalRecords(candidates.filter(t => t.source === "local"));
    const previous = tracks[cur], removed = musicLibrary.removeFromGroup(action.groupId, action.songId), removedIds = new Set(removed.map(t => t.id));
    tracks = tracks.filter(t => !removedIds.has(t.id)); cur = previous ? tracks.indexOf(previous) : -1;
    if (previous && removedIds.has(previous.id) && !window.mikuRoom?.active) resetSoloPlayer();
    for (const song of removed) if (song.url?.startsWith("blob:")) URL.revokeObjectURL(song.url);
    saveMusicLibrary(); savePlayQueue(); renderPlaylist();
    toast(action.songId ? "已从此歌单移除歌曲。" : action.groupId === "local" ? "已清空本地导入。" : "已删除此歌单。");
  } catch (err) { toast(err.message || "删除失败，请重试。"); }
  finally { for (const song of candidates) song.deleting = false; libraryDeleting = false; $("libraryConfirmDelete").disabled = $("libraryCancelDelete").disabled = false; cancelLibraryDeletion(); renderMusicLibrary(); $("libraryDeleteGroup").disabled ? $("musicLibraryClose").focus() : $("libraryDeleteGroup").focus(); }
});
window.addEventListener("miku-netease-auth", renderMusicLibrary);
$("libraryPlayAll").addEventListener("click", () => {
  if (window.mikuRoom?.active) return;
  const songs = musicLibrary.groupSongs(selectedLibraryGroup); if (!songs.length) return;
  tracks = songs.slice(); resetSoloPlayer(); savePlayQueue(); closeMusicLibrary(); playIndex(0); $("playlist").classList.add("open");
  toast(`正在播放「${musicLibrary.group(selectedLibraryGroup).name}」· 播放列表已替换为 ${tracks.length} 首`);
});
$("musicLibraryModal").addEventListener("click", e => { if (e.target === $("musicLibraryModal")) closeMusicLibrary(); });
$("musicLibraryModal").addEventListener("keydown", e => {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    if (libraryDeletion) { cancelLibraryDeletion(); $("libraryDeleteGroup").focus(); }
    else if (e.target === $("librarySearch") && $("librarySearch").value) { $("librarySearch").value = ""; updateLibrarySearch(); }
    else closeMusicLibrary();
  }
  if (e.key === "Tab") {
    const focusable = [...$("musicLibraryModal").querySelectorAll("button:not(:disabled), input:not(:disabled)")].filter(el => el.getClientRects().length);
    if (e.shiftKey && document.activeElement === focusable[0]) { e.preventDefault(); focusable.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === focusable.at(-1)) { e.preventDefault(); focusable[0]?.focus(); }
  }
});

btnPlay.addEventListener("click", () => {
  if (window.mikuRoom?.active) { window.mikuRoom.control("toggle"); return; }
  if (cur === -1) { if (tracks.length) playIndex(0); else openMusicLibrary(); return; }
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
let playlistPointerStartedInside = false;
document.addEventListener("pointerdown", e => { playlistPointerStartedInside = $("playlist").contains(e.target); }, true);
document.addEventListener("click", e => {
  const startedInside = playlistPointerStartedInside; playlistPointerStartedInside = false;
  const list = $("playlist");
  if (!list.classList.contains("open") || e.button !== 0 || startedInside || !(e.target instanceof Element) || list.contains(e.target)) return;
  if (e.target.closest('button, a, input, select, textarea, label, summary, [role="button"], [role="slider"], [role="switch"], [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"]), [draggable="true"], .vol-icon, .modal-mask')) return;
  list.classList.remove("open");
  // Closing the queue takes this click, so a wallpaper click only closes the queue.
  e.preventDefault(); e.stopPropagation();
}, true);

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

let todos = MikuPersonal.normalizeTodos((() => {
  try { return JSON.parse(localStorage.getItem("mikuFocusTodos_v1")) || []; }
  catch { return []; }
})());
const TASK_FOCUS_KEY = "mikuFocusTaskFocus_v1";
function loadTaskFocus() { try { return MikuPersonal.normalizeLedger(JSON.parse(localStorage.getItem(TASK_FOCUS_KEY))); } catch { return MikuPersonal.normalizeLedger(null); } }
let taskFocus = loadTaskFocus();
function taskTotal(id) { return taskFocus.totals[id] || 0; }
function creditTaskSession(id, task, ms) {
  if (!task?.id) return;
  taskFocus = MikuPersonal.creditFocus(loadTaskFocus(), { id, taskId: task.id, ms });
  localStorage.setItem(TASK_FOCUS_KEY, JSON.stringify(taskFocus));
}
function renderTaskPicker() {
  const picker = $("focusTask");
  const selected = state === IDLE ? selectedTaskId : activeTask?.id || "";
  picker.replaceChildren(new Option("不关联任务", ""));
  for (const t of todos) if (!t.done || (state !== IDLE && t.id === selected)) picker.add(new Option(t.text + (t.done ? "（已完成）" : ""), t.id));
  if (state !== IDLE && activeTask && !todos.some(t => t.id === selected)) picker.add(new Option(activeTask.text + "（已移除）", selected));
  picker.value = selected;
  if (!picker.value && state === IDLE && selectedTaskId) {
    selectedTaskId = "";
    localStorage.removeItem("mikuFocusSelectedTask_v1");
  }
  picker.disabled = state !== IDLE;
  picker.title = state === IDLE ? "开始前选择本段要专注的任务" : "本段任务已固定，结束后可切换";
}
function renderTaskProgress() {
  const task = state === IDLE ? todos.find(t => t.id === selectedTaskId) : activeTask;
  const elapsed = state !== IDLE ? studyElapsed() : 0;
  $("focusTaskCaption").hidden = !task;
  $("focusTaskName").textContent = task ? `${state === IDLE ? "准备专注" : "本段任务"} · ${task.text}` : "";
  $("focusTaskTime").textContent = task ? fmtClock(taskTotal(task.id) + elapsed) : "";
  for (const label of document.querySelectorAll(".todo-focus-time")) {
    label.textContent = `累计 ${fmtClock(taskTotal(label.dataset.taskId) + (activeTask?.id === label.dataset.taskId && state !== IDLE ? elapsed : 0))}`;
  }
}
$("focusTask").addEventListener("change", e => {
  selectedTaskId = e.target.value; localStorage.setItem("mikuFocusSelectedTask_v1", selectedTaskId); renderTodos();
});
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
      li.className = "todo-item" + (t.done ? " done" : "") + ((state === IDLE ? selectedTaskId : activeTask?.id) === t.id ? " focus-selected" : "");
      li.draggable = true;

      const grip = document.createElement("span");
      grip.className = "todo-grip";
      grip.title = "拖动排序";
      grip.textContent = "⠿";

      const check = document.createElement("span");
      check.className = "todo-check";
      check.textContent = "✓";

      const detail = document.createElement("div"); detail.className = "todo-detail";
      const text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = t.text;
      const spent = document.createElement("span"); spent.className = "todo-focus-time"; spent.dataset.taskId = t.id;
      detail.append(text, spent);
      const focus = document.createElement("button"); focus.type = "button"; focus.className = "todo-focus";
      focus.textContent = state !== IDLE && activeTask?.id === t.id ? "本段" : selectedTaskId === t.id ? "已选" : "专注";
      focus.title = "选择为本段专注任务"; focus.setAttribute("aria-label", `专注任务：${t.text}`);
      focus.disabled = state !== IDLE || t.done;
      focus.addEventListener("click", e => { e.stopPropagation(); selectedTaskId = t.id; localStorage.setItem("mikuFocusSelectedTask_v1", t.id); renderTodos(); toast(`已选择“${t.text}”，点击“开始学习”即可计时。`); });

      const del = document.createElement("button");
      del.className = "todo-del";
      del.textContent = "✕";
      del.title = "删除";
      del.disabled = state !== IDLE && activeTask?.id === t.id;
      if (del.disabled) del.title = "结束本段专注后可删除";
      del.addEventListener("click", (e) => { e.stopPropagation(); todos.splice(i, 1); saveTodos(); renderTodos(); });

      li.append(grip, check, detail, focus, del);
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
  renderTaskPicker(); renderTaskProgress();
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
  todos.push({ id: MikuPersonal.makeId(), text: v, done: false });
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

saveTodos(); // Assign stable IDs to existing tasks without losing their text or completion state.
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
renderTodos();
updatePlayBtn();
renderPlaylist();
const libraryReady = initLibrary();

// Minimal bridge for the optional room layer; personal data stays in this page.
window.mikuFocus = {
  getStudy: () => ({ status: state, elapsedMs: state === IDLE ? 0 : studyElapsed() }),
  getTrack: () => ({ name: tracks[cur]?.name || "房主还没有播放音乐", playing: !audio.paused && Boolean(tracks[cur]) }),
  getVolume: () => userVolume,
  setVolume: (value) => applyVolume(value * 100),
  addOnlineTracks,
  clearAccountTracks,
  libraryReady,
  openLibrary: openMusicLibrary,
  pickLocalFiles: pickPersonalFiles,
  restorePlayer: () => { npName.textContent = tracks[cur]?.name || "从音乐库选择喜欢的音乐"; updatePlayBtn(); renderPlaylist(); applyPlayMode(); seekBar.disabled = cur < 0; },
};
window.addEventListener("miku-room-change", () => {
  // A fade started before entering a room must never pause everybody's music.
  cancelMusicFade();
  musicHeldByStudy = false;
  setPlaybackVolume(userVolume);
  renderMusicLibrary();
});
