"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNeteaseProvider, parsePlaylistId, safeMusicUrl } = require('../netease.cjs');
function fixtureProvider() {
  const calls=[];
  const fetcher=async (value)=>{
    const url=new URL(value); calls.push(url.href);
    if(url.pathname==='/api/v6/playlist/detail') {
      if(url.searchParams.get('id')==='9') return Response.json({code:401,message:'private'});
      return Response.json({code:200,playlist:{name:'测试歌单',trackCount:4,trackIds:[{id:11},{id:12},{id:13},{id:14}],tracks:[{id:11,name:'可播放',ar:[{name:'歌手'}],dt:60000,fee:8}]}});
    }
    if(url.pathname==='/api/v3/song/detail') return Response.json({code:200,songs:[{id:12,name:'会员歌曲',dt:60000,fee:1},{id:13,name:'无外链',dt:60000,fee:0},{id:14,name:'受限重定向',dt:60000,fee:0}]});
    if(url.pathname==='/song/media/outer/url') {
      const id=url.searchParams.get('id');
      if(id==='11.mp3') return new Response(null,{status:302,headers:{location:'http://m10.music.126.net/example.mp3'}});
      if(id==='14.mp3') return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});
      return new Response('<html>not available</html>',{headers:{'content-type':'text/html'}});
    }
    if(url.hostname==='m10.music.126.net') return new Response(Buffer.from('MP3'),{status:206,headers:{'content-type':'audio/mpeg'}});
    throw new Error('Unexpected upstream request');
  };
  return {provider:createNeteaseProvider({fetch:fetcher}),calls};
}
test('playlist parsing accepts IDs and official links but rejects arbitrary URLs',()=>{
  assert.equal(parsePlaylistId('123456789'),'123456789');
  assert.equal(parsePlaylistId('https://music.163.com/playlist?id=123456789&uct2=anything'),'123456789');
  assert.equal(parsePlaylistId('https://music.163.com/#/playlist?id=123456789'),'123456789');
  for(const url of ['https://music.163.com.evil.test/playlist?id=1','http://127.0.0.1/playlist?id=1','https://music.163.com/song?id=1','https://user@music.163.com/playlist?id=1','file:///etc/passwd','0','123<script>']) assert.throws(()=>parsePlaylistId(url));
  assert.throws(()=>safeMusicUrl('http://127.0.0.1/audio'));
});
test('full track IDs are expanded; unavailable/paid tracks are distinct from public playable audio',async()=>{
  const {provider,calls}=fixtureProvider(); const p=await provider.getPlaylist('1');
  assert.equal(p.total,4);assert.equal(p.tracks.length,4);assert.equal(p.available,1);assert.equal(p.tracks[0].artist,'歌手');
  assert.equal(p.tracks[1].available,false);assert.match(p.tracks[1].reason,/权限/);assert.equal(p.tracks[2].available,false);assert.equal(p.tracks[3].available,false);
  assert.ok(!calls.some(u=>u.includes('12.mp3')));assert.ok(!calls.some(u=>u.includes('127.0.0.1')));
  const before=calls.length;await provider.getPlaylist('1');assert.equal(calls.length,before);
  assert.equal(await provider.resolveAudio('11'),'https://m10.music.126.net/example.mp3');
});
test('private playlist returns a clear permission error without requesting songs',async()=>{
  const {provider,calls}=fixtureProvider(); await assert.rejects(provider.getPlaylist('9'),e=>e.status===403&&e.message.includes('隐私'));assert.equal(calls.length,1);
});
