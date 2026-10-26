"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNeteaseAuth } = require('../netease-auth.cjs');
const { createRoomServer } = require('../server.cjs');
const { authFixture } = require('./helpers/netease-auth-fixture.cjs');
function client(auth) {
  let cookie;
  const session = auth.ensure({ headers: {} }, { setHeader: (name, value) => { cookie = value.split(';')[0]; } }, true);
  return { session, req: { headers: { cookie } } };
}
async function login(auth, s) { const qr = await auth.startQr(s); assert.match(qr.image, /^data:image\/png;base64,/); const result = await auth.checkQr(s, qr.challenge); assert.equal(result.code, 803); return qr; }
function memoryStore() {
  let saved=[];
  return { load:()=>structuredClone(saved), save:async records=>{saved=structuredClone(records);} };
}
test('remembered login survives a service restart, verifies the platform, and remains isolated per browser', async () => {
  const store=memoryStore(), fixture=authFixture();
  let auth=createNeteaseAuth({store,fetch:fixture.fetcher,publicProvider:fixture.publicProvider});
  const a=client(auth), b=client(auth);
  const qr=await auth.startQr(a.session,true); await auth.checkQr(a.session,qr.challenge); await login(auth,b.session);
  assert.equal(auth.status(a.session).remembered,true); assert.equal(store.load().length,1);
  let cookieHeader;auth.writeCookie(a.session,{setHeader:(_,value)=>{cookieHeader=value;}},true);assert.match(cookieHeader,/Secure; Max-Age=\d+/);
  await auth.close();
  auth=createNeteaseAuth({store,fetch:fixture.fetcher,publicProvider:fixture.publicProvider});
  const restored=auth.find(a.req);assert.ok(restored); assert.equal(auth.find(b.req),null);
  fixture.control.profileFailures=1; await assert.rejects(auth.refresh(restored));assert.equal(store.load().length,1);
  await auth.refresh(restored);assert.equal(auth.status(restored).loggedIn,true);
  assert.equal(await auth.provider(a.req).resolveAudio('12'),'https://m10.music.126.net/user-1-12.mp3');
  await auth.remember(restored,false);assert.deepEqual(store.load(),[]);assert.equal(restored.loggedIn,true);
  await auth.remember(restored,true);auth.logout(restored);await auth.flush();assert.deepEqual(store.load(),[]);
  await auth.close();const fresh=createNeteaseAuth({store,fetch:fixture.fetcher,publicProvider:fixture.publicProvider});assert.equal(fresh.find(a.req),null);await fresh.close();
});
test('platform expiry and local remember expiry invalidate persisted login; a failed save cannot falsely report remembered', async () => {
  const store=memoryStore(), fixture=authFixture();let auth=createNeteaseAuth({store,fetch:fixture.fetcher,publicProvider:fixture.publicProvider});const a=client(auth);
  let qr=await auth.startQr(a.session,true);await auth.checkQr(a.session,qr.challenge);await auth.close();
  auth=createNeteaseAuth({store,fetch:fixture.fetcher,publicProvider:fixture.publicProvider});fixture.control.profileExpired=true;
  await auth.refresh(auth.find(a.req));await auth.flush();assert.equal(auth.provider(a.req),fixture.publicProvider);assert.deepEqual(store.load(),[]);await auth.close();
  fixture.control.profileExpired=false;auth=createNeteaseAuth({store,fetch:fixture.fetcher,publicProvider:fixture.publicProvider});const b=client(auth);
  qr=await auth.startQr(b.session,true);await auth.checkQr(b.session,qr.challenge);b.session.rememberUntil=0;assert.equal(auth.find(b.req),null);await auth.flush();assert.deepEqual(store.load(),[]);await auth.close();
  const broken={load:()=>[],save:async()=>{throw new Error('disk full');}};auth=createNeteaseAuth({store:broken,fetch:fixture.fetcher,publicProvider:fixture.publicProvider});const c=client(auth);
  qr=await auth.startQr(c.session,true);const status=await auth.checkQr(c.session,qr.challenge);assert.equal(status.loggedIn,true);assert.equal(status.remembered,false);assert.match(status.rememberWarning,/无法/);await auth.close();
});

test('QR status, session isolation, individual audio permissions, preview rejection and logout', async () => {
  const fixture = authFixture(), auth = createNeteaseAuth({ fetch: fixture.fetcher, publicProvider: fixture.publicProvider });
  const a = client(auth), b = client(auth), anon = client(auth);
  const q = await auth.startQr(a.session);
  await assert.rejects(auth.checkQr(b.session, q.challenge), e => e.status === 409);
  fixture.control.code = 801; assert.equal((await auth.checkQr(a.session, q.challenge)).code, 801);
  a.session.challenge.lastPoll = 0; fixture.control.code = 802; assert.equal((await auth.checkQr(a.session, q.challenge)).code, 802);
  a.session.challenge.lastPoll = 0; fixture.control.code = 803; assert.equal((await auth.checkQr(a.session, q.challenge)).code, 803);
  await login(auth, b.session);
  const pa = auth.provider(a.req), pb = auth.provider(b.req);
  assert.notEqual(pa, pb);
  assert.equal(await pa.resolveAudio('12'), 'https://m10.music.126.net/user-1-12.mp3');
  assert.equal(await pb.resolveAudio('12'), 'https://m10.music.126.net/user-2-12.mp3');
  await assert.rejects(auth.provider(anon.req).resolveAudio('12'), e => e.status === 404);
  await assert.rejects(pa.resolveAudio('13'), e => e.status === 404 && /试听/.test(e.message));
  const list = await pa.getPlaylist('9'); assert.equal(list.available, 2); assert.equal(list.tracks[1].requiresLogin, true); assert.equal(list.tracks[0].requiresLogin, false);
  await assert.rejects(fixture.publicProvider.getPlaylist('9'), e => e.status === 403);
  assert.ok(!JSON.stringify(auth.status(a.session)).includes('MUSIC_U'));
  const csrf = a.session.csrf; auth.logout(a.session); assert.notEqual(a.session.csrf, csrf); assert.equal(a.session.jar.size, 0);
  assert.equal(auth.provider(a.req), fixture.publicProvider); assert.equal(auth.status(b.session).loggedIn, true);
  assert.ok(!fixture.calls.filter(c => c.path === '/song/media/outer/url').some(c => c.cookie));
  auth.close();
});

test('cancelled and expired challenges cannot authorize, and expired account is cleared', async () => {
  const fixture = authFixture(), auth = createNeteaseAuth({ fetch: fixture.fetcher, publicProvider: fixture.publicProvider }), a = client(auth);
  const q = await auth.startQr(a.session); a.session.challenge.expires = 0;
  assert.equal((await auth.checkQr(a.session, q.challenge)).code, 800); auth.logout(a.session);
  await assert.rejects(auth.checkQr(a.session, q.challenge), e => e.status === 409);
  await login(auth, a.session); fixture.control.expired = true;
  await assert.rejects(auth.provider(a.req).resolveAudio('12'), e => e.status === 401);
  assert.equal(a.session.loggedIn, false); assert.equal(a.session.jar.size, 0);
  auth.close();
});

test('phone confirmation survives an HTML account response and completed checks can be retried safely', async () => {
  const fixture = authFixture(), auth = createNeteaseAuth({ fetch: fixture.fetcher, publicProvider: fixture.publicProvider }), a = client(auth), b = client(auth);
  const qr = await auth.startQr(a.session); fixture.control.profileFailures = 1;
  await assert.rejects(auth.checkQr(a.session, qr.challenge), e => e.status === 502 && !/Unexpected token|DOCTYPE/.test(e.message));
  assert.equal(a.session.challenge.authorized, true); assert.equal(a.session.loggedIn, false);
  const pending = await auth.checkQr(a.session, qr.challenge); assert.equal(pending.code, 802); assert.equal(pending.loggedIn, false);
  a.session.challenge.lastPoll = 0;
  const success = await auth.checkQr(a.session, qr.challenge); assert.equal(success.code, 803); assert.equal(success.loggedIn, true);
  assert.deepEqual(await auth.checkQr(a.session, qr.challenge), success);
  assert.equal(fixture.calls.filter(c => c.path.endsWith('/qrcode/client/login')).length, 1);
  await assert.rejects(auth.checkQr(b.session, qr.challenge), e => e.status === 409);
  auth.logout(a.session); await assert.rejects(auth.checkQr(a.session, qr.challenge), e => e.status === 409);
  auth.close();
});

test('8821 is a terminal platform rejection, never a network retry or successful login', async () => {
  const fixture = authFixture(), diagnostics = [], auth = createNeteaseAuth({ fetch: fixture.fetcher, publicProvider: fixture.publicProvider, diagnostic: d => diagnostics.push(d) }), a = client(auth);
  const qr = await auth.startQr(a.session); fixture.control.code = 8821;
  await assert.rejects(auth.checkQr(a.session, qr.challenge), e => e.status === 423 && /8821/.test(e.message));
  const calls = fixture.calls.length; fixture.control.code = 803; a.session.challenge.lastPoll = 0;
  await assert.rejects(auth.checkQr(a.session, qr.challenge), e => e.status === 423); assert.equal(fixture.calls.length, calls);
  assert.equal(a.session.loggedIn, false); assert.equal(a.session.jar.has('MUSIC_U'), false);
  assert.deepEqual(Object.keys(diagnostics.at(-1)).sort(), ['code', 'hasLoginCookie', 'httpStatus', 'stage']);
  assert.equal(diagnostics.at(-1).code, 8821);
  auth.logout(a.session); auth.close();
});

test('HTTP login requires CSRF and same origin; logout blocks an in-flight account audio response', async t => {
  const fixture = authFixture(), app = createRoomServer({ env: {}, authStore: null, authFetch: fixture.fetcher, netease: fixture.publicProvider });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(origin + '/api/netease/auth/status'), cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  let state = await response.json();
  const post = (path, headers = {}) => fetch(origin + '/api/netease/auth/' + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': state.csrf, ...headers } });
  assert.equal((await post('qr', { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await post('qr', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('remember', { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await post('remember', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await fetch(origin + '/api/netease/auth/remember', { method:'POST', headers:{ Cookie:cookie,Origin:origin,'X-CSRF-Token':state.csrf,'Content-Type':'application/json' },body:'{"remember":"invalid"}' })).status, 400);
  const qr = await (await post('qr')).json(); state = await (await post('check?challenge=' + qr.challenge)).json(); assert.equal(state.loggedIn, true);
  assert.equal((await fetch(origin + '/api/netease/audio/12', { redirect: 'manual' })).status, 404);
  let release; fixture.control.hold = new Promise(r => { release = r; });
  const audio = fetch(origin + '/api/netease/audio/12', { headers: { Cookie: cookie }, redirect: 'manual' });
  while (!fixture.calls.some(c => c.path === '/api/song/enhance/player/url/v1')) await new Promise(r => setTimeout(r, 5));
  const oldCsrf = state.csrf; state = await (await post('logout')).json(); release();
  assert.equal((await audio).status, 401); assert.equal(state.loggedIn, false);
  assert.equal((await post('qr', { 'X-CSRF-Token': oldCsrf })).status, 403);
  assert.equal((await fetch(origin + '/netease-auth.cjs')).status, 404);
});
