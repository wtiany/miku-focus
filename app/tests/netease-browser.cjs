"use strict";
// Opt-in integration check. Supply the playlist locally; no personal IDs or names are stored here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { createRoomServer } = require('../server.cjs');
(async()=>{
 const playlistLink=process.env.MIKU_TEST_PLAYLIST;
 if(!playlistLink){console.log('SKIP: set MIKU_TEST_PLAYLIST locally to a public playlist with at least two playable tracks.');return;}
 const app=createRoomServer({env:{},authStore:null}); await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const origin=`http://localhost:${app.server.address().port}`;
 const b=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true}); const errors=[];
 try {
  const ctx=await b.newContext({viewport:{width:1366,height:900},reducedMotion:'reduce'}); const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(60000);
  await p.goto(origin,{waitUntil:'domcontentloaded'});await p.locator('#btnImport').click();await p.locator('#neteaseLink').fill(playlistLink);await p.locator('#neteaseCheck').click();
  await p.locator('#neteaseResults').waitFor({state:'visible'}); await p.locator('#neteaseImport').waitFor({state:'visible'}); await p.waitForFunction(()=>!document.getElementById('neteaseImport').disabled);
  const count=await p.locator('.netease-track[data-available="true"]').count();assert.ok(count>=2,'Choose a playlist with at least two playable tracks.');
  assert.ok((await p.locator('#neteasePlaylistName').innerText()).trim());
  const nextName=await p.locator('.netease-track[data-available="true"] .netease-track-detail a').nth(1).innerText();
  fs.mkdirSync('test-results',{recursive:true});await p.screenshot({path:'test-results/netease-desktop.png'});
  await p.setViewportSize({width:390,height:844});await p.screenshot({path:'test-results/netease-mobile.png'});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await p.setViewportSize({width:1366,height:900});await p.locator('#neteaseImport').click();await p.locator('#musicLibraryModal').waitFor({state:'visible'});assert.equal(await p.locator('.pl-row').count(),0);assert.equal(await p.locator('.library-song').count(),count);await p.locator('#libraryPlayAll').click();await p.waitForFunction(n=>document.querySelectorAll('.pl-row').length===n,count);
  await p.waitForFunction(()=>{const a=document.getElementById('audio');return !a.paused&&a.readyState>=3&&a.currentTime>.5&&a.duration>0});
  console.log(`PASS: ${count} public tracks imported; selected audio decodes and plays`);
  await p.reload({waitUntil:'domcontentloaded'});await p.waitForFunction(n=>document.querySelectorAll('.pl-row').length===n,count);await p.locator('#btnImport').click();await p.locator('#neteaseCheck').click();await p.waitForFunction(()=>!document.getElementById('neteaseImport').disabled);await p.locator('#neteaseImport').click();assert.equal(await p.locator('.pl-row').count(),count);
  console.log('PASS: online metadata survives refresh; repeated imports do not duplicate songs');
  await p.locator('#musicLibraryClose').click();await p.locator('#roomLaunch').click();await p.locator('#roomName').fill('歌单房主');await p.locator('#roomCreate').click();await p.locator('#roomActive').waitFor({state:'visible'});const code=await p.locator('#roomActiveCode').innerText();
  await p.locator('#roomImportNetease').click();await p.locator('#neteaseCheck').click();await p.waitForFunction(()=>!document.getElementById('neteaseImport').disabled);await p.locator('#neteaseImport').click();await p.waitForFunction(n=>document.querySelectorAll('.pl-row').length===n,count);
  const gc=await b.newContext({viewport:{width:1366,height:900},reducedMotion:'reduce'});const g=await gc.newPage();g.on('pageerror',e=>errors.push(e.message));await g.goto(`${origin}/#room=${code}`,{waitUntil:'domcontentloaded'});await g.locator('#roomName').fill('歌单朋友');await g.locator('#roomJoin').click();await g.locator('#roomActive').waitFor({state:'visible'});
  await p.locator('#btnPlay').click();if(await g.locator('#roomAudio').evaluate(a=>a.paused)) await g.locator('#roomListen').click();
  for(const page of [p,g]) await page.waitForFunction(()=>{const a=document.getElementById('roomAudio');return !a.paused&&a.currentTime>.5&&a.duration>0});
  await g.locator('#btnNext').click();await p.waitForFunction(name=>document.getElementById('roomSong').textContent===name,nextName);await p.waitForFunction(()=>document.getElementById('roomAudio').currentTime>.2);
  await g.locator('#btnPlay').click();await p.waitForFunction(()=>document.getElementById('roomAudio').paused);
  console.log('PASS: shared room imports the checked list; both browsers play; guest switches and pauses music');
  await p.locator('#roomEnd').click();assert.deepEqual(errors,[]);
  const result=await(await fetch(origin+'/api/netease/playlist?link='+encodeURIComponent(playlistLink))).json();fs.writeFileSync('test-results/netease-import-report.json',JSON.stringify(result,null,2));
 }finally{await b.close();await app.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
