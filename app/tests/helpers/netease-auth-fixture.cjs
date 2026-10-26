"use strict";
const { createNeteaseProvider } = require('../../netease.cjs');
const { createDecipheriv, createHash } = require('node:crypto');
function authFixture() {
  let counter = 0;
  const calls = [], control = { code: 803, expired: false, hold: null };
  const fetcher = async (value, options = {}) => {
    const u = new URL(value), cookie = options.headers?.Cookie || '';
    let params = {};
    if (u.pathname.startsWith('/eapi/')) {
      if (options.method !== 'POST') throw new Error('QR API must use POST');
      const decrypt = createDecipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null);
      const decoded = Buffer.concat([decrypt.update(Buffer.from(new URLSearchParams(options.body).get('params'), 'hex')), decrypt.final()]).toString('utf8');
      const [path, json, digest] = decoded.split('-36cd479b6b5-');
      if (digest !== createHash('md5').update(`nobody${path}use${json}md5forencrypt`).digest('hex')) throw new Error('Invalid QR API signature');
      params = JSON.parse(json); u.pathname = path;
      if (params.e_r !== false || !params.header.deviceId) throw new Error('Missing QR client parameters');
    }
    if (u.pathname.startsWith('/weapi/')) { if (options.method !== 'POST' || !new URLSearchParams(options.body).get('encSecKey')) throw new Error('Missing web API parameters'); u.pathname = u.pathname.replace('/weapi/', '/api/'); }
    calls.push({ path: u.pathname, cookie, deviceId: params.header?.deviceId });
    if (u.pathname.endsWith('/qrcode/unikey')) return Response.json({ code: 200, unikey: 'fixture-key-1234567890-' + (++counter) }, { headers: { 'Set-Cookie': `qr_owner=${counter}; HttpOnly` } });
    if (u.pathname.endsWith('/qrcode/client/login')) {
      const owner = /-(\d+)$/.exec(params.key)?.[1];
      return Response.json({ code: control.code }, { headers: control.code === 803 ? { 'Set-Cookie': `MUSIC_U=fixture-user-${owner}; HttpOnly` } : {} });
    }
    const owner = /MUSIC_U=fixture-user-(\d+)/.exec(cookie)?.[1];
    if (u.pathname === '/api/w/nuser/account/get') {
      if (control.profileExpired) return Response.json({ code: 301 });
      if (control.profileFailures > 0) { control.profileFailures--; return new Response('<!DOCTYPE html><html>Temporary upstream error</html>', { headers: { 'Content-Type': 'text/html' } }); }
      return Response.json({ code: 200, profile: owner ? { userId: owner, nickname: '测试账号' + owner } : null });
    }
    if (u.pathname === '/api/song/enhance/player/url/v1') {
      if (control.hold) await control.hold;
      if (control.expired) return Response.json({ code: 301 });
      const id = String(JSON.parse(u.searchParams.get('ids'))[0]);
      return Response.json({ code: 200, data: [{ id: Number(id), code: owner ? 200 : 404, url: owner ? `https://m10.music.126.net/user-${owner}-${id}.mp3` : null, expi: 300, freeTrialInfo: id === '13' ? { start: 0, end: 30 } : null }] });
    }
    if (u.pathname === '/api/v6/playlist/detail') {
      if (u.searchParams.get('id') === '9' && !owner) return Response.json({ code: 401 });
      return Response.json({ code: 200, playlist: { name: '权限测试歌单', trackCount: 3, tracks: [
        { id: 11, name: '公开歌曲', ar: [{ name: '测试歌手' }], dt: 60000, fee: 0 },
        { id: 12, name: '账号歌曲', dt: 60000, fee: 1 }, { id: 13, name: '试听歌曲', dt: 60000, fee: 1 }
      ] } });
    }
    if (u.pathname === '/song/media/outer/url') return u.searchParams.get('id') === '11.mp3'
      ? new Response(null, { status: 302, headers: { Location: 'https://m10.music.126.net/public.mp3' } })
      : new Response('not audio', { headers: { 'Content-Type': 'text/html' } });
    if (u.hostname === 'm10.music.126.net') return new Response('mp3', { headers: { 'Content-Type': 'audio/mpeg' } });
    throw new Error('Unexpected fixture request: ' + u.pathname);
  };
  return { fetcher, calls, control, publicProvider: createNeteaseProvider({ fetch: fetcher }) };
}
module.exports = { authFixture };
