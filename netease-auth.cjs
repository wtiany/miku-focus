"use strict";
const { randomBytes } = require('node:crypto');
const QRCode = require('qrcode');
const { createNeteaseProvider, NeteaseError } = require('./netease.cjs');
const { eapiRequest, weapiRequest } = require('./netease-protocol.cjs');
const COOKIE_NAME = 'miku_netease_session';
const BASE_HEADERS = { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' };
const BLOCKED_MESSAGE = '网易云拒绝了本次扫码登录（8821）。请到网易云官网使用官方登录方式完成必要的安全验证；反复刷新二维码无法解决。';
function createNeteaseAuth(options = {}) {
  const fetcher = options.fetch || fetch, accounts = new Map();
  const publicProvider = options.publicProvider;
  function report(s, route, details) {
    const stage = route.includes('unikey') ? 'qr' : route.includes('client/login') ? 'scan' : 'account';
    const diagnostic = { stage, ...details, hasLoginCookie: s.jar.has('MUSIC_U') };
    const signature = JSON.stringify(diagnostic);
    if (s.lastDiagnostic !== signature) {
      s.lastDiagnostic = signature;
      if (options.diagnostic) options.diagnostic(diagnostic);
    }
  }
  function prune() {
    for (const [id, s] of accounts) if (Date.now() - s.lastSeen > (s.loggedIn ? 12 * 3600000 : 10 * 60000)) { clear(s); accounts.delete(id); }
  }
  function find(req) {
    prune();
    const id = (req.headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE_NAME+'='))?.slice(COOKIE_NAME.length+1);
    const s = /^[a-f0-9]{64}$/.test(id || '') ? accounts.get(id) : null;
    if (s) s.lastSeen = Date.now();
    return s || null;
  }
  function cookieHeader(s) { return [...s.jar].map(([name,value])=>`${name}=${value}`).join('; '); }
  function mergeCookies(s, headers) {
    for (const raw of headers.getSetCookie?.() || []) {
      const pair = raw.split(';',1)[0], at = pair.indexOf('=');
      if (at<=0) continue;
      const name=pair.slice(0,at), value=pair.slice(at+1);
      if (!/^[a-zA-Z0-9_]+$/.test(name) || /[\r\n;]/.test(value)) continue;
      if (/max-age=0(?:;|$)/i.test(raw) || !value) s.jar.delete(name); else s.jar.set(name,value);
    }
  }
  function ensure(req,res,secure) {
    let s=find(req); if(s) return s;
    if(accounts.size>=100) { const old=[...accounts.values()].filter(v=>!v.loggedIn).sort((a,b)=>a.lastSeen-b.lastSeen)[0]; if(old) { clear(old); accounts.delete(old.id); } else throw new NeteaseError('登录人数较多，请稍后重试。',429); }
    s={id:randomBytes(32).toString('hex'),deviceId:randomBytes(16).toString('hex'),csrf:randomBytes(24).toString('hex'),jar:new Map(),loggedIn:false,name:'',profileId:'',lastSeen:Date.now(),challenge:null,qrStarts:[],provider:null,epoch:0};
    accounts.set(s.id,s);
    res.setHeader('Set-Cookie',`${COOKIE_NAME}=${s.id}; Path=/; HttpOnly; SameSite=Strict${secure?'; Secure':''}`);
    return s;
  }
  function clear(s) { s.epoch++; s.jar.clear(); s.loggedIn=false; s.name=''; s.profileId=''; s.provider=null; s.challenge=null; s.completedChallenge=null; }
  async function upstream(s,route,params={}) {
    const epoch=s.epoch;
    const wire=route.includes('/qrcode/') ? eapiRequest(route,params,s.jar,s.deviceId) : weapiRequest(route,params,s.jar);
    let r;
    try { r=await fetcher(wire.url,{method:wire.method,body:wire.body,headers:{...BASE_HEADERS,...wire.headers},redirect:'error',signal:AbortSignal.timeout(12000)}); }
    catch { report(s,route,{error:'connection'}); throw new NeteaseError(route.includes('account/get')?'手机已确认，但无法连接网易云账号验证接口。':'无法连接网易云扫码验证接口。'); }
    if(!r.ok) { report(s,route,{httpStatus:r.status,error:'http'}); throw new NeteaseError(`网易云${route.includes('account/get')?'账号':'扫码'}验证接口返回 HTTP ${r.status}。`); }
    let data;
    try { data=await r.json(); } catch { report(s,route,{httpStatus:r.status,error:'non-json'}); throw new NeteaseError(`网易云${route.includes('account/get')?'账号':'扫码'}验证接口返回了网页，未返回登录状态。`); }
    if(!data || typeof data!=='object' || Array.isArray(data)) throw new NeteaseError('网易云暂未返回有效登录状态，正在等待重试。');
    if(s.epoch!==epoch) throw new NeteaseError('登录状态已改变，请重试。',409);
    mergeCookies(s,r.headers); report(s,route,{httpStatus:r.status,code:Number(data.code)||0}); return data;
  }
  function status(s) { return {loggedIn:s.loggedIn,name:s.name,csrf:s.csrf}; }
  async function startQr(s) {
    const now=Date.now(); s.qrStarts=s.qrStarts.filter(t=>now-t<60000);
    if(s.qrStarts.length>=3) throw new NeteaseError('二维码刷新过快，请稍后重试。',429);
    if(s.loggedIn) throw new NeteaseError('已登录，请先退出后再切换账号。',409);
    if(s.starting) throw new NeteaseError('二维码正在生成，请稍候。',429);
    s.qrStarts.push(now);s.starting=true; const epoch=s.epoch;
    try {
      const data=await upstream(s,'/api/login/qrcode/unikey',{type:3});
      const key=data.unikey || data.data?.unikey;
      if(data.code!==200 || typeof key!=='string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new NeteaseError('网易云暂未返回有效二维码，请重试。');
      if(s.epoch!==epoch) throw new NeteaseError('登录已取消。',409);
      const challenge={id:randomBytes(24).toString('hex'),key,expires:Date.now()+3*60000,lastPoll:0,code:801,polling:false};
      s.challenge=challenge;
      const url='https://music.163.com/login?codekey='+encodeURIComponent(key);
      return {challenge:challenge.id,image:await QRCode.toDataURL(url,{width:216,margin:2,errorCorrectionLevel:'M'}),expiresAt:challenge.expires};
    } finally {s.starting=false;}
  }
  async function checkQr(s,id) {
    if(s.loggedIn && s.completedChallenge?.id===id && s.completedChallenge.expires>Date.now()) return {code:803,message:'登录成功，可以重新读取歌单。',...status(s)};
    const c=s.challenge;
    if(!c || c.id!==id) throw new NeteaseError('二维码已更新，请重新扫码。',409);
    if(c.blocked) throw new NeteaseError(BLOCKED_MESSAGE,423);
    if(c.expires<Date.now()) return {code:800,message:'二维码已过期，请刷新。',...status(s)};
    if(c.polling || Date.now()-c.lastPoll<2500) return {code:c.code,message:c.authorized?'手机已确认，正在核实登录状态。':c.code===802?'已扫码，请在手机确认。':'等待扫码',...status(s)};
    c.polling=true;c.lastPoll=Date.now();const epoch=s.epoch;
    try {
      const data=c.authorized ? {code:803} : await upstream(s,'/api/login/qrcode/client/login',{type:3,key:c.key});
      if(s.epoch!==epoch || s.challenge!==c) throw new NeteaseError('登录已取消。',409);
      const code=Number(data.code);
      if(code===8821) { c.blocked=true; throw new NeteaseError(BLOCKED_MESSAGE,423); }
      c.code=code===803 ? 802 : code;
      if(code===803) {
        if(!s.jar.get('MUSIC_U')) throw new NeteaseError('网易云未返回登录会话，请刷新二维码重试。');
        c.authorized=true;
        const account=await upstream(s,'/api/w/nuser/account/get');
        if(s.epoch!==epoch || s.challenge!==c) throw new NeteaseError('登录已取消。',409);
        const profile=account.profile || account.data?.profile;
        if(account.code===301 || account.code===401) { clear(s);throw new NeteaseError('网易云未确认账号登录，请重新扫码。',401); }
        if(account.code!==200 || !profile?.userId) throw new NeteaseError('手机已确认，网易云账号状态暂未同步，正在等待重试。');
        s.epoch++;s.loggedIn=true;s.name=String(profile.nickname || '网易云用户').slice(0,60);s.profileId=String(profile.userId);
        s.provider=createNeteaseProvider({fetch:fetcher,cookie:()=>s.loggedIn?cookieHeader(s):'',publicProvider,onExpired:()=>clear(s)});s.completedChallenge={id:c.id,expires:c.expires};s.challenge=null;
        return {code:803,message:'登录成功，可以重新读取歌单。',...status(s)};
      }
      if(c.code===800) {s.challenge=null;return {code:800,message:'二维码已过期，请刷新。',...status(s)};}
      if(![801,802].includes(c.code)) throw new NeteaseError('网易云暂时无法确认扫码状态，请重试。');
      return {code:c.code,message:c.code===802?'已扫码，请在网易云手机 App 上确认。':'等待扫码',...status(s)};
    } finally {c.polling=false;}
  }
  function logout(s) { clear(s); s.csrf=randomBytes(24).toString('hex');return status(s); }
  function provider(req) { const s=find(req);return s?.loggedIn?s.provider:publicProvider; }
  function close() {for(const s of accounts.values()) clear(s);accounts.clear();}
  return {find,ensure,status,startQr,checkQr,logout,provider,close};
}
module.exports={createNeteaseAuth};
