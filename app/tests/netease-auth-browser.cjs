"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { createRoomServer } = require('../server.cjs');
const { authFixture } = require('./helpers/netease-auth-fixture.cjs');
function wave() {
  const samples = 8000 * 60, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  return data;
}
(async () => {
  const fixture = authFixture(), app = createRoomServer({ env: {}, authStore: null, netease: fixture.publicProvider, authFetch: fixture.fetcher });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://localhost:${app.server.address().port}`, errors = [];
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const contexts = await Promise.all([browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' }), browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })]);
    const requests = [[], []];
    for (const [i, ctx] of contexts.entries()) {
      await ctx.route('**/api/netease/audio/*', async route => {
        const result = await route.fetch({ maxRedirects: 0 }); assert.equal(result.status(), 302);
        requests[i].push(result.headers().location);
        await route.fulfill({ contentType: 'audio/wav', body: wave() });
      });
      ctx.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    }
    // Reproduce a gateway HTML error, then lose an already completed authorization response.
    let checkAttempts = 0, statusLost = false;
    await contexts[0].route('**/api/netease/auth/check?*', async route => {
      checkAttempts++;
      if (checkAttempts === 1) { await route.fulfill({ status: 502, contentType: 'text/html', body: '<!DOCTYPE html><html>Bad gateway</html>' }); return; }
      if (checkAttempts === 2) { await route.fetch(); await route.fulfill({ status: 200, contentType: 'text/html', body: '<!DOCTYPE html><html>Lost response</html>' }); return; }
      await route.continue();
    });
    await contexts[0].route('**/api/netease/auth/status', async route => {
      if (checkAttempts === 2 && !statusLost) { statusLost = true; await route.fulfill({ status: 503, contentType: 'text/html', body: '<html>Temporarily offline</html>' }); return; }
      await route.continue();
    });
    const p = await contexts[0].newPage(); await p.goto(origin); await p.locator('#btnImport').click(); await p.locator('#neteaseLogin').click();
    await p.locator('#neteaseQrImage').waitFor({ state: 'visible' });
    fs.mkdirSync('test-results', { recursive: true });
    await p.screenshot({ path: 'test-results/netease-login-desktop.png' });
    await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: 'test-results/netease-login-mobile.png' });
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.setViewportSize({ width: 1366, height: 900 });
    await p.waitForFunction(() => document.getElementById('neteaseQrStatus').textContent.includes('自动重试'));
    assert.equal(await p.locator('#neteaseQrImage').isVisible(), true);
    await p.waitForFunction(() => window.mikuNetease.loggedIn); assert.match(await p.locator('#neteaseAccount').innerText(), /测试账号1/);
    assert.equal(checkAttempts, 3); assert.equal(fixture.calls.filter(c => c.path.endsWith('/qrcode/unikey')).length, 1);
    const tab = await contexts[0].newPage(); await tab.goto(origin); await tab.waitForFunction(() => window.mikuNetease.loggedIn);
    await p.locator('#neteaseLink').fill('1'); await p.locator('#neteaseCheck').click(); await p.waitForFunction(() => !document.getElementById('neteaseImport').disabled);
    assert.equal(await p.locator('.netease-track[data-available="true"]').count(), 2); assert.match(await p.locator('#neteaseTracks').innerText(), /账号可播/);
    await p.locator('#neteaseImport').click(); await p.locator('#musicLibraryModal').waitFor({ state: 'visible' });
    assert.equal(await p.locator('.pl-row').count(), 0); assert.equal(await p.locator('.library-song').count(), 2);
    assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('mikuFocusMusicLibrary_v2')).playlists[0].tracks.length), 2);
    await p.locator('#libraryPlayAll').click(); assert.equal(await p.locator('.pl-row').count(), 2);
    await p.bringToFront(); await p.locator('.pl-row').filter({ hasText: '账号歌曲' }).click();
    await p.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').readyState >= 3).catch(async e => { console.log(await p.locator('#audio').evaluate(a => ({ paused: a.paused, ready: a.readyState, error: a.error?.code })), requests); throw e; });
    await p.locator('#btnImport').click(); await p.locator('#neteaseLogout').click(); await p.waitForFunction(() => !window.mikuNetease.loggedIn);
    await tab.waitForFunction(() => !window.mikuNetease.loggedIn); assert.equal(await p.locator('.pl-row').count(), 2); assert.equal(await p.locator('#audio').evaluate(a => a.paused && !a.getAttribute('src')), true);
    assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('mikuFocusMusicLibrary_v2')).playlists[0].tracks.length), 2);
    await p.locator('#neteaseLogin').click(); await p.waitForFunction(() => window.mikuNetease.loggedIn);
    await p.locator('#neteaseClose').click(); await p.locator('#roomLaunch').click(); await p.locator('#roomName').fill('账号房主'); await p.locator('#roomCreate').click(); await p.locator('#roomActive').waitFor({ state: 'visible' });
    const code = await p.locator('#roomActiveCode').innerText(); await p.locator('#roomImportNetease').click(); await p.locator('#neteaseCheck').click(); await p.waitForFunction(() => !document.getElementById('neteaseImport').disabled); await p.locator('#neteaseImport').click();
    const g = await contexts[1].newPage(); await g.goto(origin + '/#room=' + code); await g.locator('#roomName').fill('独立账号朋友'); await g.locator('#roomJoin').click(); await g.locator('#roomActive').waitFor({ state: 'visible' });
    await p.locator('.pl-row').filter({ hasText: '账号歌曲' }).click(); await p.waitForFunction(() => !document.getElementById('roomAudio').paused && document.getElementById('roomAudio').readyState >= 3);
    await g.waitForFunction(() => document.getElementById('roomMessage').textContent.includes('扫码登录'));
    assert.equal(await g.locator('#roomAudio').evaluate(a => a.paused && !a.getAttribute('src')), true);
    await g.locator('#roomImportNetease').click(); await g.locator('#neteaseLogin').click(); await g.waitForFunction(() => window.mikuNetease.loggedIn);
    await g.locator('#neteaseClose').click(); if (await g.locator('#roomAudio').evaluate(a => a.paused)) await g.locator('#roomListen').click();
    await g.waitForFunction(() => !document.getElementById('roomAudio').paused && document.getElementById('roomAudio').readyState >= 3);
    assert.ok(requests[0].some(u => u.endsWith('user-2-12.mp3'))); assert.ok(requests[1].some(u => u.endsWith('user-3-12.mp3')));
    assert.ok(!requests[1].some(u => u.includes('user-2')));
    await p.locator('#roomImportNetease').click(); await p.locator('#neteaseLogout').click(); await p.waitForFunction(() => document.getElementById('roomAudio').paused && !document.getElementById('roomAudio').getAttribute('src'));
    assert.equal(await g.locator('#roomAudio').evaluate(a => a.paused), false);
    await p.locator('#neteaseClose').click(); await p.locator('#roomEnd').click(); assert.deepEqual(errors, []);
    const blockedContext = await browser.newContext(); const blocked = await blockedContext.newPage();
    fixture.control.code = 8821; await blocked.goto(origin); await blocked.locator('#btnImport').click(); await blocked.locator('#neteaseLogin').click();
    await blocked.locator('#neteaseOfficial').waitFor({ state: 'visible' });
    assert.match(await blocked.locator('#neteaseQrStatus').innerText(), /8821/); assert.equal(await blocked.locator('#neteaseQrRefresh').isDisabled(), true);
    assert.equal(await blocked.locator('#neteaseQrImage').isVisible(), false); assert.equal(await blocked.evaluate(() => window.mikuNetease.loggedIn), false);
    await blockedContext.close();
    console.log('PASS: QR UI/recovery, authorized import/playback, account isolation, logout, and terminal 8821 rejection with official login guidance');
  } finally { await browser.close(); await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
