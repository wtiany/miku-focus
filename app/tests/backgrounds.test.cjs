"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {createBackgroundStore}=require("../background-store.cjs"),{createRoomServer}=require("../server.cjs");
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=","base64");
function cleanup(root){for(const entry of fs.readdirSync(root,{withFileTypes:true})){const target=path.join(root,entry.name);if(entry.isDirectory()&&!entry.isSymbolicLink())cleanup(target);else fs.unlinkSync(target);}fs.rmdirSync(root);}
test("background copies have content-based filenames, merge simultaneous duplicates and survive restart",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"miku-background-unit-"));
 try{
  const store=createBackgroundStore({directory:root});const results=await Promise.all([store.save(png,"../../假日.png"),store.save(png,"同一张.png")]);
  assert.equal(results.filter(r=>r.added).length,1);assert.match(results[0].item.src,/^assets\/images\/custom-[a-f0-9]{64}\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(root,path.basename(results[0].item.src))),png);
  assert.equal((await createBackgroundStore({directory:root}).list()).length,1);
  const script=fs.readFileSync(path.join(root,"custom-backgrounds.js"),"utf8");assert.ok(script.startsWith("globalThis.MikuCustomBackgrounds = "));
  await assert.rejects(store.save(Buffer.from("<svg><script>bad</script></svg>"),"bad.svg"),e=>e.status===400);
  await assert.rejects(createBackgroundStore({directory:root,maxBytes:32}).save(png,"big.png"),e=>e.status===413);
  assert.equal((await store.list()).length,1);
 }finally{cleanup(root);}
});
test("background API only accepts local same-origin writes with its token, serves copied files and blocks forwarded clients",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"miku-background-http-")),app=createRoomServer({env:{},authStore:null,backgroundDirectory:root});
 await new Promise(r=>app.server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${app.server.address().port}`;
 try{
  const initial=await fetch(origin+"/app/assets/images/custom-backgrounds.js");assert.equal(initial.status,200);assert.equal(await initial.text(),"globalThis.MikuCustomBackgrounds = [];\n");
  const info=await(await fetch(origin+"/api/backgrounds")).json();assert.equal(info.canUpload,true);assert.ok(info.token);
  const post=(extra={})=>fetch(origin+"/api/backgrounds",{method:"POST",headers:{Origin:origin,"X-Background-Token":info.token,"X-File-Name":encodeURIComponent("我的背景.png"),...extra},body:png});
  assert.equal((await post({"X-Background-Token":"bad"})).status,403);
  assert.equal((await post({Origin:"https://untrusted.example"})).status,403);
  assert.equal((await post({"X-Forwarded-For":"203.0.113.8"})).status,403);
  const remote=await(await fetch(origin+"/api/backgrounds",{headers:{"CF-Connecting-IP":"203.0.113.8"}})).json();assert.equal(remote.canUpload,false);assert.equal(remote.token,undefined);
  const result=await(await post()).json();assert.equal(result.added,true);const image=await fetch(origin+"/app/"+result.item.src);assert.equal(image.status,200);assert.equal(image.headers.get("content-type"),"image/png");assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  const script=await fetch(origin+"/app/assets/images/custom-backgrounds.js");assert.equal(script.status,200);assert.equal(script.headers.get("cache-control"),"no-cache");assert.match(await script.text(),/我的背景/);
  assert.equal((await fetch(origin+"/app/background-store.cjs")).status,404);assert.equal((await fetch(origin+"/app/assets/images/test.json")).status,404);
 }finally{await app.close();cleanup(root);}
});
