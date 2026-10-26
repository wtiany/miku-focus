"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { chromium } = require("playwright"), { createRoomServer } = require("../server.cjs"), { createCredentialStore } = require("../credential-store.cjs");
const { authFixture } = require("./helpers/netease-auth-fixture.cjs");
function wave() {
  const b = Buffer.alloc(44 + 8000 * 2 * 60); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
(async () => {
  if (process.platform !== "win32") { console.log("SKIP: remembered login requires Windows DPAPI"); return; }
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"miku-remember-browser-")), fixture=authFixture(), errors=[];
  let app, browser;
  const start=async port=>{app=createRoomServer({env:{},netease:fixture.publicProvider,authFetch:fixture.fetcher,authStore:createCredentialStore({directory})});await new Promise(r=>app.server.listen(port,"127.0.0.1",r));return `http://localhost:${app.server.address().port}`;};
  const context=async state=>{
    const ctx=await browser.newContext({viewport:{width:1366,height:900},reducedMotion:"reduce",...(state?{storageState:state}:{})});
    ctx.on("page",p=>p.on("pageerror",e=>errors.push(e.message)));
    await ctx.route("**/api/netease/audio/*",async route=>{const res=await route.fetch({maxRedirects:0});assert.equal(res.status(),302);await route.fulfill({contentType:"audio/wav",body:wave()});});return ctx;
  };
  try {
    let origin=await start(0);const port=app.server.address().port;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || "msedge",headless:true});
    let ctx=await context(),p=await ctx.newPage();await p.goto(origin);await p.locator("#btnImport").click();await p.waitForFunction(()=>!document.getElementById("neteaseRemember").disabled);assert.equal(await p.locator("#neteaseRemember").isChecked(),true);
    await p.locator("#neteaseLogin").click();await p.waitForFunction(()=>window.mikuNetease.loggedIn);
    assert.match(await p.locator("#neteaseAccountHint").innerText(),/已记住/);
    const cookie=(await ctx.cookies()).find(c=>c.name==="miku_netease_session");assert.ok(cookie.httpOnly && cookie.sameSite==="Strict" && cookie.expires>Date.now()/1000+86400);
    await p.locator("#neteaseLink").fill("1");await p.locator("#neteaseCheck").click();await p.waitForFunction(()=>!document.getElementById("neteaseImport").disabled);await p.locator("#neteaseImport").click();await p.locator("#musicLibraryModal").waitFor({state:"visible"});await p.locator("#libraryPlayAll").click();
    const state=await ctx.storageState(), playlistCalls=fixture.calls.filter(c=>c.path.includes("playlist/detail")).length;
    await browser.close();browser=null;await app.close();app=null;
    origin=await start(port);browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || "msedge",headless:true});ctx=await context(state);p=await ctx.newPage();await p.goto(origin);await p.waitForFunction(()=>window.mikuNetease.loggedIn);await p.evaluate(()=>window.mikuFocus.libraryReady);
    assert.equal(await p.locator(".pl-row").count(),2);await p.locator("#btnList").click();await p.locator(".pl-row").filter({hasText:"账号歌曲"}).click();await p.waitForFunction(()=>!document.getElementById("audio").paused && document.getElementById("audio").readyState>=3);
    assert.equal(fixture.calls.filter(c=>c.path.endsWith("/qrcode/unikey")).length,1);assert.equal(fixture.calls.filter(c=>c.path.includes("playlist/detail")).length,playlistCalls);
    const anon=await context(),anonymous=await anon.newPage();await anonymous.goto(origin);await anonymous.evaluate(()=>window.mikuFocus.libraryReady);assert.equal(await anonymous.evaluate(()=>window.mikuNetease.loggedIn),false);assert.equal((await anon.request.get(origin+"/api/netease/audio/12",{maxRedirects:0})).status(),404);await anon.close();
    await p.locator("#btnImport").click();assert.equal(await p.locator("#neteaseRemember").isChecked(),true);
    fs.mkdirSync("test-results",{recursive:true});await p.screenshot({path:"test-results/remember-login-desktop.png"});await p.setViewportSize({width:390,height:844});await p.screenshot({path:"test-results/remember-login-mobile.png"});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await p.locator("#neteaseRemember").uncheck();await p.waitForFunction(()=>document.getElementById("neteaseAccountHint").textContent.includes("可勾选"));assert.equal(createCredentialStore({directory}).load().length,0);
    await p.locator("#neteaseRemember").check();await p.waitForFunction(()=>document.getElementById("neteaseAccountHint").textContent.includes("已记住"));
    await p.locator("#neteaseLogout").click();await p.waitForFunction(()=>!window.mikuNetease.loggedIn);assert.equal(createCredentialStore({directory}).load().length,0);
    assert.equal(await p.locator("#audio").evaluate(a=>a.paused && !a.getAttribute("src")),true);assert.equal(await p.locator(".pl-row").count(),2);
    await p.locator("#neteaseClose").click();await p.locator("#btnLibrary").click();assert.equal(await p.locator(".library-song").count(),0);await p.locator('.library-group[data-group-id="netease:1"]').click();assert.equal(await p.locator(".library-song").count(),2);assert.match(await p.locator("#librarySongs").innerText(),/需要登录/);
    await p.reload();await p.evaluate(()=>window.mikuFocus.libraryReady);assert.equal(await p.locator(".pl-row").count(),2);await p.locator("#btnList").click();await p.locator(".pl-row").filter({hasText:"账号歌曲"}).click();await p.locator("#neteaseModal").waitFor({state:"visible"});assert.equal(await p.locator("#audio").evaluate(a=>a.paused),true);
    assert.deepEqual(errors,[]);console.log("PASS: real Windows encryption + browser/server restart restores login and member-song playback without QR/reimport; browser isolation, remember toggle, logout and locked metadata retention");
  } finally {
    if(browser) await browser.close();if(app) await app.close();for(const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory,name));fs.rmdirSync(directory);
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
