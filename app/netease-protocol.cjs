"use strict";
// Request formats used by the NetEase web/desktop clients. This does not grant permissions.
const { createCipheriv, createHash, publicEncrypt, randomBytes, constants } = require('node:crypto');
const WEB_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
function aes(text, key, mode, iv) {
  const cipher = createCipheriv(mode, Buffer.from(key), iv ? Buffer.from(iv) : null);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
}
function eapiRequest(route, params, cookies, deviceId) {
  const header = { os: 'pc', appver: '3.1.17.204416', osver: 'Microsoft-Windows-10-Professional-build-19045-64bit', channel: 'netease', deviceId, requestId: `${Date.now()}_${randomBytes(4).toString('hex')}`, __csrf: cookies.get('__csrf') || '' };
  if (cookies.has('MUSIC_U')) header.MUSIC_U = cookies.get('MUSIC_U');
  const text = JSON.stringify({ ...params, header, e_r: false });
  const digest = createHash('md5').update(`nobody${route}use${text}md5forencrypt`).digest('hex');
  const encrypted = aes(`${route}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, 'e82ckenh8dichen8', 'aes-128-ecb').toString('hex').toUpperCase();
  return { url: 'https://interfacepc.music.163.com' + route.replace(/^\/api\//, '/eapi/'), method: 'POST', body: new URLSearchParams({ params: encrypted }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: Object.entries(header).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('; '), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117' } };
}
function weapiRequest(route, params, cookies) {
  const secret = randomBytes(8).toString('hex'), iv = '0102030405060708';
  const first = aes(JSON.stringify({ ...params, csrf_token: cookies.get('__csrf') || '' }), '0CoJUm6Qyw8W8jud', 'aes-128-cbc', iv).toString('base64');
  const encrypted = aes(first, secret, 'aes-128-cbc', iv).toString('base64');
  const padded = Buffer.alloc(128); Buffer.from(secret.split('').reverse().join('')).copy(padded, 112);
  const encSecKey = publicEncrypt({ key: WEB_KEY, padding: constants.RSA_NO_PADDING }, padded).toString('hex');
  return { url: 'https://music.163.com' + route.replace(/^\/api\//, '/weapi/'), method: 'POST', body: new URLSearchParams({ params: encrypted, encSecKey }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') } };
}
module.exports = { eapiRequest, weapiRequest };
