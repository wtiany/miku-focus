"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { pathToFileURL } = require("node:url"), { chromium } = require("playwright");
const { createRoomServer } = require("../server.cjs");
function wave() {
  const b = Buffer.alloc(44 + 8000 * 2 * 90); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
const songs = { "11": "第一首歌", "12": "共同收藏", "13": "第三首歌" };
const provider = {
  async getPlaylist(input) {
    if (/103/.test(String(input))) {
      const tracks = Array.from({ length: 55 }, (_, index) => ({ id: String(21 + index), name: `Focus Session ${index + 1}`, artist: index % 2 ? "雨夜音源" : "初音未来", available: true, duration: 90, link: `https://music.163.com/song?id=${21 + index}` }));
      return { id: "103", name: "专注时光 · 收藏", total: tracks.length, checked: tracks.length, available: tracks.length, tracks };
    }
    const id = /102/.test(String(input)) ? "102" : "101", ids = id === "101" ? ["11", "12"] : ["12", "13"];
    return { id, name: id === "101" ? "夜间学习" : "休息音乐", total: 2, checked: 2, available: 2, tracks: ids.map(id => ({ id, name: songs[id], artist: "测试歌手", available: true, duration: 90, link: `https://music.163.com/song?id=${id}` })) };
  },
  async resolveAudio() { return "https://m10.music.126.net/fixture.mp3"; }
};
(async () => {
  const app = createRoomServer({ env: {}, authStore: null, netease: provider }); await new Promise(r => app.server.listen(0, "127.0.0.1", r));
  const origin = `http://localhost:${app.server.address().port}`, errors = [];
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
    await ctx.route("**/api/netease/audio/*", route => {
      const data = wave(), range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || "");
      if (!range) return route.fulfill({ contentType: "audio/wav", headers: { "Accept-Ranges": "bytes" }, body: data });
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      return route.fulfill({ status: 206, contentType: "audio/wav", headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${data.length}` }, body: data.subarray(start, end + 1) });
    });
    ctx.on("page", p => p.on("pageerror", e => errors.push(e.message)));
    const p = await ctx.newPage(); await p.goto(origin); await p.evaluate(() => window.mikuFocus.libraryReady);
    const importPlaylist = async id => {
      if (await p.locator("#musicLibraryModal").isVisible()) await p.locator("#libraryImportNetease").click(); else await p.locator("#btnImport").click();
      await p.locator("#neteaseLink").fill(id); await p.locator("#neteaseCheck").click(); await p.waitForFunction(() => !document.getElementById("neteaseImport").disabled);
      await p.locator("#neteaseImport").click(); await p.locator("#musicLibraryModal").waitFor({ state: "visible" });
    };
    await importPlaylist("101"); assert.equal(await p.locator(".pl-row").count(), 0); assert.equal(await p.locator(".library-song").count(), 2);
    await importPlaylist("102"); assert.deepEqual(await p.locator(".library-group strong").allTextContents(), ["本地导入", "夜间学习", "休息音乐"]);
    await importPlaylist("101"); assert.equal(await p.locator(".library-group").count(), 3); assert.equal(await p.locator(".library-song").count(), 2);
    await p.locator("#libraryPlayAll").click(); await p.waitForFunction(() => !document.getElementById("audio").paused && document.getElementById("audio").readyState >= 3);
    assert.deepEqual(await p.locator(".pl-name").allTextContents(), ["第一首歌", "共同收藏"]);
    await p.locator("#audio").evaluate(a => { a.pause(); a.currentTime = 17; });
    await p.waitForFunction(() => !document.getElementById("audio").seeking && document.getElementById("audio").currentTime === 17);
    await p.locator("#btnLibrary").click(); await p.locator('.library-group[data-group-id="netease:102"]').click();
    const sharedToggle = p.locator('.library-song[data-id="netease-song:12"] .library-song-add');
    assert.equal(await sharedToggle.isDisabled(), false); assert.equal(await sharedToggle.innerText(), "从列表移除");
    await sharedToggle.click(); assert.deepEqual(await p.locator(".pl-name").allTextContents(), ["第一首歌"]);
    assert.equal(await p.locator(".library-song").count(), 2); assert.equal(await p.locator("#audio").evaluate(a => a.currentTime), 17);
    await sharedToggle.click(); assert.deepEqual(await p.locator(".pl-name").allTextContents(), ["第一首歌", "共同收藏"]);
    await p.locator('.library-song[data-id="netease-song:13"] .library-song-add').click();
    assert.deepEqual(await p.locator(".pl-name").allTextContents(), ["第一首歌", "共同收藏", "第三首歌"]);
    assert.equal(await p.locator("#npName").innerText(), "第一首歌"); assert.equal(await p.locator("#audio").evaluate(a => a.currentTime), 17);
    await p.locator("#libraryPlayAll").click(); assert.deepEqual(await p.locator(".pl-name").allTextContents(), ["共同收藏", "第三首歌"]);
    await p.locator(".pl-del").first().click(); assert.equal(await p.locator(".pl-row").count(), 1);
    await p.locator("#btnLibrary").click(); assert.equal(await p.locator(".library-song").count(), 2);
    await p.locator("#fileInput").setInputFiles([{ name: "本地练习.wav", mimeType: "audio/wav", buffer: wave() }, { name: "雨夜环境.wav", mimeType: "audio/wav", buffer: wave() }]);
    await p.waitForFunction(() => document.getElementById("libraryGroupName").textContent === "本地导入" && document.querySelectorAll(".library-song").length === 2);
    assert.equal(await p.locator(".pl-row").count(), 1);
    // A repeated selection of the exact same file is ignored, including its persisted fingerprint.
    await p.evaluate(() => {
      const song = musicLibrary.groupSongs("local")[0], [name, , lastModified] = JSON.parse(song.fingerprint), transfer = new DataTransfer();
      transfer.items.add(new File([song.blob], name, { type: "audio/wav", lastModified })); const input = document.getElementById("fileInput"); input.files = transfer.files; input.dispatchEvent(new Event("change"));
    });
    await p.waitForFunction(() => document.getElementById("toast").textContent.includes("已在音乐库")); assert.equal(await p.locator(".library-song").count(), 2);
    fs.mkdirSync("test-results", { recursive: true });
    await p.locator('.library-group[data-group-id="netease:101"]').click(); await p.screenshot({ path: "test-results/music-library-desktop.png" });
    await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: "test-results/music-library-mobile.png" });
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const bounds = await p.locator(".music-library-dialog").boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844);
    await p.locator("#musicLibraryClose").focus(); await p.keyboard.press("Shift+Tab"); assert.equal(await p.locator("#musicLibraryClose").evaluate(e => e !== document.activeElement), true);
    await p.keyboard.press("Tab"); assert.equal(await p.locator("#musicLibraryClose").evaluate(e => e === document.activeElement), true);
    await p.keyboard.press("Escape"); assert.equal(await p.locator("#btnLibrary").evaluate(e => e === document.activeElement), true);
    await p.setViewportSize({ width: 1366, height: 900 }); await p.locator("#btnList").click(); await p.locator(".pl-clear").click();
    await p.reload(); await p.evaluate(() => window.mikuFocus.libraryReady); assert.equal(await p.locator(".pl-row").count(), 0);
    await p.locator("#btnLibrary").click(); assert.equal(await p.locator(".library-group").count(), 3);
    await p.locator('.library-group[data-group-id="local"]').click(); assert.equal(await p.locator(".library-song").count(), 2);
    await p.locator("#libraryPlayAll").click(); await p.waitForFunction(() => !document.getElementById("audio").paused && document.getElementById("audio").readyState >= 3);
    await p.locator(".pl-del").first().click(); await p.reload(); await p.evaluate(() => window.mikuFocus.libraryReady);
    assert.deepEqual(await p.locator(".pl-name").allTextContents(), ["雨夜环境"]); await p.locator("#btnLibrary").click(); assert.equal(await p.locator(".library-song").count(), 2);
    console.log("PASS: imports grouped by source, repeat import merges, full playlist replaces queue, single add preserves progress, queue removal/clear preserves saved collections, mobile layout and keyboard");

    await p.locator("#musicLibraryClose").click(); await p.locator("#roomLaunch").click(); await p.locator("#roomName").fill("音乐库检查"); await p.locator("#roomCreate").click(); await p.locator("#roomActive").waitFor({ state: "visible" });
    await p.locator("#btnLibrary").click(); assert.equal(await p.locator("#libraryPlayAll").isDisabled(), true); assert.equal(await p.locator(".library-song-add:not(:disabled)").count(), 0);
    await importPlaylist("101"); assert.equal(await p.locator(".pl-row").count(), 0); assert.equal(await p.locator("#libraryPlayAll").isDisabled(), true);
    await p.locator("#musicLibraryClose").click(); await p.locator("#roomImportNetease").click(); await p.locator("#neteaseCheck").click(); await p.waitForFunction(() => !document.getElementById("neteaseImport").disabled); await p.locator("#neteaseImport").click();
    await p.waitForFunction(() => document.querySelectorAll(".pl-row").length === 2); await p.locator("#roomEnd").click(); await p.locator("#roomLobby").waitFor({ state: "visible" });
    assert.deepEqual(await p.locator(".pl-name").allTextContents(), ["雨夜环境"]);
    console.log("PASS: personal collection imports stay separate in rooms, shared import still fills room queue, leaving restores personal queue");

    await p.locator("#btnLibrary").click(); await p.locator('.library-group[data-group-id="netease:101"]').click();
    const removeShared = p.locator('.library-song[data-id="netease-song:12"] .library-song-delete');
    await removeShared.click(); await p.keyboard.press("Escape"); assert.equal(await p.locator("#musicLibraryModal").isVisible(), true); assert.equal(await p.locator(".library-song").count(), 2);
    await removeShared.click(); await p.locator("#libraryConfirmDelete").click(); await p.waitForFunction(() => document.querySelectorAll(".library-song").length === 1);
    await p.locator('.library-group[data-group-id="netease:102"]').click(); assert.equal(await p.locator(".library-song").count(), 2);
    await p.locator('.library-group[data-group-id="netease:101"]').click(); await p.locator("#libraryDeleteGroup").click(); await p.locator("#libraryConfirmDelete").click();
    await p.locator('.library-group[data-group-id="netease:101"]').waitFor({ state: "detached" });
    await p.locator('.library-group[data-group-id="netease:102"]').click(); await p.locator("#libraryPlayAll").click(); await p.locator("#btnLibrary").click();
    for (const id of ["13", "12"]) { await p.locator(`.library-song[data-id="netease-song:${id}"] .library-song-delete`).click(); await p.locator("#libraryConfirmDelete").click(); await p.locator(`.library-song[data-id="netease-song:${id}"]`).waitFor({ state: "detached" }); }
    assert.equal(await p.locator(".pl-row").count(), 0); assert.equal(await p.locator("#audio").evaluate(a => a.paused && !a.getAttribute("src")), true);
    await p.reload(); await p.evaluate(() => window.mikuFocus.libraryReady); await p.locator("#btnLibrary").click(); await p.locator('.library-group[data-group-id="netease:102"]').click(); assert.equal(await p.locator(".library-song").count(), 0);
    await p.locator("#libraryDeleteGroup").click(); await p.locator("#libraryConfirmDelete").click(); await p.locator('.library-group[data-group-id="netease:102"]').waitFor({ state: "detached" });
    await p.locator(".library-song-delete").first().click(); await p.locator("#libraryConfirmDelete").click(); await p.waitForFunction(() => document.querySelectorAll(".library-song").length === 1);
    assert.equal(await p.evaluate(() => new Promise(resolve => { const req=db.transaction("tracks").objectStore("tracks").count(); req.onsuccess=()=>resolve(req.result); })), 1);
    await p.locator("#libraryPlayAll").click(); await p.locator("#btnLibrary").click(); await p.locator("#libraryDeleteGroup").click();
    await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: "test-results/music-library-delete-mobile.png" }); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.locator("#libraryConfirmDelete").click(); await p.waitForFunction(() => document.querySelectorAll(".library-song").length === 0);
    assert.equal(await p.locator("#audio").evaluate(a => a.paused && !a.getAttribute("src")), true);
    await p.reload(); await p.evaluate(() => window.mikuFocus.libraryReady); await p.locator("#btnLibrary").click(); assert.equal(await p.locator(".library-group").count(), 1); assert.equal(await p.locator(".library-song").count(), 0);
    assert.equal(await p.evaluate(() => new Promise(resolve => { const req=db.transaction("tracks").objectStore("tracks").count(); req.onsuccess=()=>resolve(req.result); })), 0);
    console.log("PASS: song/playlist delete confirmation, cancel, shared-song preservation, playback stop, local IndexedDB deletion and reload without resurrection");

    await p.setViewportSize({ width: 1366, height: 900 }); await importPlaylist("103");
    const search = p.locator("#librarySearch");
    await search.fill("ｆｏｃｕｓ　11 初音"); assert.deepEqual(await p.locator(".library-song-detail strong").allTextContents(), ["Focus Session 11"]);
    assert.match(await p.locator("#libraryGroupCount").innerText(), /找到 1 首 \/ 共 55 首/); assert.equal(await search.evaluate(e => e === document.activeElement), true);
    await p.locator("#libraryPlayAll").click(); assert.equal(await p.locator(".pl-row").count(), 55);
    await p.waitForFunction(() => !document.getElementById("audio").paused && document.getElementById("audio").readyState >= 3);
    const queueBounds = await p.locator("#playlist").boundingBox(); assert.ok(queueBounds.height >= 500 && queueBounds.y >= 16);
    assert.ok(await p.locator("#playlist").evaluate(box => parseFloat(getComputedStyle(box,"::-webkit-scrollbar").width)>=12));
    await p.mouse.move(queueBounds.x+queueBounds.width-6,queueBounds.y+24); await p.mouse.down(); await p.mouse.move(queueBounds.x+queueBounds.width-6,queueBounds.y+174,{steps:10}); await p.mouse.up();
    await p.waitForFunction(() => document.getElementById("playlist").scrollTop>100); assert.equal(await p.locator("#playlist").evaluate(box=>box.classList.contains("open")),true);
    await p.locator("#playlist").evaluate(box=>{box.scrollTop=0;});
    const fullyVisible = await p.locator("#playlist").evaluate(box => { const b=box.getBoundingClientRect(), head=box.querySelector(".pl-head").getBoundingClientRect(); return [...box.querySelectorAll(".pl-row")].filter(row=>{const r=row.getBoundingClientRect();return r.top>=head.bottom && r.bottom<=b.bottom;}).length; });
    assert.ok(fullyVisible >= 8); await p.screenshot({ path: "test-results/play-queue-expanded-desktop.png" });
    const scrolled = await p.locator("#playlist").evaluate(box => { box.scrollTop=700;return box.scrollTop; });
    await p.locator("#btnPlay").click(); await p.waitForFunction(position => document.getElementById("playlist").scrollTop === position, scrolled);
    assert.equal(await p.locator("#playlist").evaluate(box=>box.classList.contains("open")),true);
    await p.locator("#volIcon").click(); assert.equal(await p.locator("#playlist").evaluate(box=>box.classList.contains("open")),true);
    await p.locator("#volIcon").click();
    const wallpaper=await p.evaluate(()=>backgroundPrefs.selectedSrc);
    await p.locator("#carousel").click({position:{x:20,y:750}}); assert.equal(await p.locator("#playlist").isVisible(),false); assert.equal(await p.evaluate(()=>backgroundPrefs.selectedSrc),wallpaper);
    await p.locator("#btnList").click(); await p.locator("#npName").click(); assert.equal(await p.locator("#playlist").isVisible(),false);
    await p.locator("#btnList").click();
    await p.locator("#audio").evaluate(a => { a.currentTime=19; }); await p.waitForFunction(() => !document.getElementById("audio").seeking && document.getElementById("audio").currentTime === 19);
    await p.locator("#btnLibrary").click(); assert.equal(await search.inputValue(), "");
    await search.fill("Focus 11 初音"); const filteredToggle=p.locator(".library-song-add"); await filteredToggle.click();
    assert.equal(await p.locator(".pl-row").count(), 54); assert.equal(await p.locator("#audio").evaluate(a => a.currentTime), 19); assert.equal(await search.inputValue(), "Focus 11 初音");
    assert.equal(await filteredToggle.innerText(), "＋ 加入列表"); await filteredToggle.click(); assert.equal(await p.locator(".pl-row").count(), 55); assert.equal(await p.locator("#audio").evaluate(a => a.currentTime), 19);
    await search.fill("雨夜"); assert.equal(await p.locator(".library-song").count(), 27);
    await search.fill("不存在的歌曲"); assert.equal(await p.locator(".library-song").count(), 0); assert.match(await p.locator(".library-empty").innerText(), /没有找到/); assert.equal(await p.locator(".pl-row").count(), 55);
    await p.keyboard.press("Escape"); assert.equal(await search.inputValue(), ""); assert.equal(await p.locator("#musicLibraryModal").isVisible(), true); assert.equal(await p.locator(".library-song").count(), 55);
    await search.fill("Focus Session 11"); await p.screenshot({ path: "test-results/music-library-search-desktop.png" });
    await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: "test-results/music-library-search-mobile.png" }); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.locator("#librarySearchClear").click(); assert.equal(await p.locator(".library-song").count(), 55); assert.equal(await search.evaluate(e => e === document.activeElement), true);
    await p.locator("#musicLibraryClose").click(); await p.locator("#btnList").click();
    for (const [width,height] of [[1366,900],[390,844],[390,568],[320,568],[568,320]]) {
      await p.setViewportSize({ width, height }); const b=await p.locator("#playlist").boundingBox(); assert.ok(b.y>=16 && b.x>=0 && b.x+b.width<=width && b.y+b.height<=height, `queue fits ${width}x${height}`);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: "test-results/play-queue-expanded-mobile.png" });
    await p.locator(".pl-clear").click(); await p.locator("#btnLibrary").click(); await search.fill("Focus Session 11"); await p.locator(".library-song-add").click(); await p.locator("#musicLibraryClose").click(); await p.locator("#btnPlay").click();
    await p.waitForFunction(() => !document.getElementById("audio").paused && document.getElementById("audio").readyState >= 3);
    await p.locator("#btnLibrary").click(); await search.fill("Focus Session 11"); await p.locator(".library-song-add").click();
    assert.equal(await p.locator(".pl-row").count(), 0); assert.equal(await p.locator("#audio").evaluate(a => a.paused && !a.getAttribute("src")), true); assert.equal(await p.locator(".library-song").count(), 1);
    await p.reload(); await p.evaluate(() => window.mikuFocus.libraryReady); await p.locator("#btnLibrary").click(); await p.locator('.library-group[data-group-id="netease:103"]').click(); assert.equal(await p.locator(".library-song").count(), 55); assert.equal(await p.locator(".pl-row").count(), 0);
    console.log("PASS: queue toggle, search, unfiltered full playback, five viewport sizes, actual scrollbar dragging, outside-blank dismissal without wallpaper change, and buttons/volume keep the queue open");

    const legacyContext = await browser.newContext(), legacy = await legacyContext.newPage(); legacy.on("pageerror", e => errors.push(e.message)); await legacy.goto(origin); await legacy.evaluate(() => window.mikuFocus.libraryReady);
    await legacy.evaluate(async () => {
      localStorage.removeItem("mikuFocusMusicLibrary_v2"); localStorage.removeItem("mikuFocusPlayQueue_v1");
      localStorage.setItem("mikuFocusNetease_v1", JSON.stringify([{ id: "11", name: "旧版网易云", duration: 90 }]));
      await new Promise((resolve, reject) => { const tx = db.transaction("tracks", "readwrite"); tx.objectStore("tracks").add({ name: "旧版本地", blob: new Blob(["RIFF"], { type: "audio/wav" }), dur: 30 }); tx.oncomplete = resolve; tx.onerror = reject; });
    });
    await legacy.reload(); await legacy.evaluate(() => window.mikuFocus.libraryReady);
    assert.deepEqual(await legacy.locator(".pl-name").allTextContents(), ["旧版本地", "旧版网易云"]);
    await legacy.locator("#btnLibrary").click(); assert.deepEqual(await legacy.locator(".library-group strong").allTextContents(), ["本地导入", "以前导入的网易云音乐"]);
    await legacy.locator("#musicLibraryClose").click(); await legacy.locator("#btnList").click(); await legacy.locator(".pl-clear").click(); await legacy.reload(); await legacy.evaluate(() => window.mikuFocus.libraryReady); assert.equal(await legacy.locator(".pl-row").count(), 0);
    await legacyContext.close();
    const offline = await ctx.newPage(); await offline.goto(pathToFileURL(path.resolve(__dirname, "../../index.html")).href); await offline.evaluate(() => window.mikuFocus.libraryReady);
    await offline.locator("#fileInput").setInputFiles({ name: "离线练习.wav", mimeType: "audio/wav", buffer: wave() }); await offline.locator("#musicLibraryModal").waitFor({ state: "visible" });
    assert.equal(await offline.locator(".pl-row").count(), 0); await offline.locator("#libraryPlayAll").click(); await offline.waitForFunction(() => !document.getElementById("audio").paused && document.getElementById("audio").readyState >= 3);
    assert.equal(await offline.locator("#npName").innerText(), "离线练习"); assert.deepEqual(errors, []);
    console.log("PASS: old local/NetEase imports migrate once, cleared queue stays empty after refresh, offline library playback works");
  } finally { await browser.close(); await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
