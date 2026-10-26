"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{pathToFileURL}=require("node:url");
const {chromium}=require("playwright"),{createRoomServer}=require("../server.cjs");
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=","base64");
function cleanup(root){for(const entry of fs.readdirSync(root,{withFileTypes:true})){const target=path.join(root,entry.name);if(entry.isDirectory()&&!entry.isSymbolicLink())cleanup(target);else fs.unlinkSync(target);}fs.rmdirSync(root);}
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),"miku-background-browser-")),project=path.resolve(__dirname,"../.."),images=path.join(temp,"app/assets/images"),errors=[];
 fs.mkdirSync(path.join(temp,"app"),{recursive:true});fs.copyFileSync(path.join(project,"index.html"),path.join(temp,"index.html"));
 for(const name of ["app.js","personal-data.js","music-library.js","room.js","netease.js","style.css","room.css"])fs.copyFileSync(path.join(project,"app",name),path.join(temp,"app",name));
 for(const name of ["images/miku_guitar_night.jpg","images/miku_ribbon.jpg","images/miku_holiday.jpg","videos/miku_sea_color.mp4","videos/miku_moon_night.mp4"]) {const target=path.join(temp,"app/assets",name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(project,"app/assets",name),target);}
 fs.writeFileSync(path.join(images,"custom-backgrounds.js"),"globalThis.MikuCustomBackgrounds = [];\n");
 let app,browser;const start=async port=>{app=createRoomServer({env:{},authStore:null,backgroundDirectory:images});await new Promise(r=>app.server.listen(port,"127.0.0.1",r));return `http://localhost:${app.server.address().port}`;};
 try{
  let origin=await start(0);const port=app.server.address().port;
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || "msedge",headless:true});const ctx=await browser.newContext({viewport:{width:1366,height:900},reducedMotion:"reduce"});ctx.on("page",p=>p.on("pageerror",e=>errors.push(e.message)));
  let p=await ctx.newPage();await p.goto(origin);await p.evaluate(()=>backgroundReady);await p.locator("#btnBackground").click();await p.locator("#backgroundStatic").check();
  const before=await p.locator(".background-choice").count(),jpeg=fs.readFileSync(path.join(project,"app/assets/images/miku_holiday.jpg"));
  await p.locator("#backgroundInput").setInputFiles([{name:"自选春日.jpg",mimeType:"image/jpeg",buffer:jpeg},{name:"小小星光.png",mimeType:"image/png",buffer:png}]);
  await p.waitForFunction(()=>document.getElementById("backgroundImportStatus").textContent.includes("已复制"));assert.equal(await p.locator(".background-choice").count(),before+2);assert.equal(await p.locator("#backgroundRotate").isChecked(),true);
  const selected=await p.evaluate(()=>backgroundPrefs.selectedId),src=await p.evaluate(()=>backgroundPrefs.selectedSrc);assert.match(src,/assets\/images\/custom-/);assert.ok(fs.existsSync(path.join(temp,"app",src)));
  await p.waitForFunction(()=>{const img=document.querySelector(".stage-layer.show img");return img.complete&&img.naturalWidth>0;});
  await p.locator("#backgroundInput").setInputFiles({name:"再次选择.jpg",mimeType:"image/jpeg",buffer:jpeg});await p.waitForFunction(()=>document.getElementById("backgroundImportStatus").textContent.includes("未重复添加"));assert.equal(await p.locator(".background-choice").count(),before+2);
  await p.locator("#backgroundInput").setInputFiles({name:"损坏图片.png",mimeType:"image/png",buffer:Buffer.from("not a real image")});await p.waitForFunction(()=>document.getElementById("backgroundImportStatus").textContent.includes("无法读取"));assert.equal(await p.locator(".background-choice").count(),before+2);
  await p.locator(".background-choice").filter({hasText:"自选春日"}).click();await p.reload();await p.evaluate(()=>backgroundReady);assert.equal(await p.evaluate(()=>backgroundPrefs.selectedId),selected);
  await p.clock.install();await p.locator("#btnBackground").click();await p.locator("#backgroundRotate").check();await p.clock.runFor(30050);assert.notEqual(await p.evaluate(()=>backgroundPrefs.selectedSrc),src);await p.locator("#backgroundRotate").uncheck();
  fs.mkdirSync("test-results",{recursive:true});await p.screenshot({path:"test-results/background-import-desktop.png"});await p.setViewportSize({width:390,height:844});await p.screenshot({path:"test-results/background-import-mobile.png"});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await p.locator("#backgroundClose").focus();await p.keyboard.press("Shift+Tab");await p.keyboard.press("Tab");assert.equal(await p.locator("#backgroundClose").evaluate(e=>e===document.activeElement),true);
  await p.close();await app.close();app=null;origin=await start(port);p=await ctx.newPage();await p.goto(origin);await p.evaluate(()=>backgroundReady);assert.equal(await p.locator(".background-choice").count(),before+2);
  const off=await ctx.newPage();await off.goto(pathToFileURL(path.join(temp,"index.html")).href);await off.evaluate(()=>backgroundReady);await off.locator("#btnBackground").click();assert.equal(await off.locator(".background-choice").count(),before+2);
  await off.locator("#backgroundInput").setInputFiles({name:"离线照片.jpg",mimeType:"image/jpeg",buffer:fs.readFileSync(path.join(project,"app/assets/images/miku_ribbon.jpg"))});await off.waitForFunction(()=>document.getElementById("backgroundImportStatus").textContent.includes("保存到本浏览器"));const offlineId=await off.evaluate(()=>backgroundPrefs.selectedId);
  await off.reload();await off.evaluate(()=>backgroundReady);assert.equal(await off.evaluate(()=>backgroundPrefs.selectedId),offlineId);assert.equal(await off.locator(".background-choice").count(),before+3);
  await off.waitForFunction(()=>{const img=document.querySelector(".stage-layer.show img");return img.complete&&img.naturalWidth>0;});
  assert.deepEqual(errors,[]);console.log("PASS: images physically copy to project, duplicates and corrupt images handled, rotation and static mode, reload/server restart, mobile/focus, file HTML reads project images, offline imports persist in browser");
 }finally{if(browser)await browser.close();if(app)await app.close();cleanup(temp);}
})().catch(e=>{console.error(e);process.exitCode=1;});
