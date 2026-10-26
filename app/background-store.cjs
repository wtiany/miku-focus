"use strict";
const fs=require("node:fs/promises"),path=require("node:path"),{createHash,randomUUID}=require("node:crypto");
const PREFIX="globalThis.MikuCustomBackgrounds = ";
function imageType(bytes) {
  if(bytes.length<32) return null;
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return "jpg";
  if(bytes.toString("ascii",0,4)==="RIFF" && bytes.toString("ascii",8,12)==="WEBP") return "webp";
  if(["GIF87a","GIF89a"].includes(bytes.toString("ascii",0,6))) return "gif";
  return null;
}
function createBackgroundStore(options={}) {
  const directory=options.directory || path.join(__dirname,"assets/images"), manifest=path.join(directory,"custom-backgrounds.js");
  let pending=Promise.resolve();
  async function list() {
    try {
      const source=await fs.readFile(manifest,"utf8");
      if(!source.startsWith(PREFIX) || source.length>200000) return [];
      const data=JSON.parse(source.slice(PREFIX.length).trim().replace(/;$/,""));
      if(!Array.isArray(data)) return [];
      const items=[];
      for(const item of data.slice(0,100)) {
        if(!/^[a-f0-9]{64}$/.test(item?.id || "") || !/^assets\/images\/custom-[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(item.src || "") || !item.src.includes(`custom-${item.id}.`)) continue;
        try { if(!(await fs.stat(path.join(directory,path.basename(item.src)))).isFile()) continue; } catch {continue;}
        items.push({id:item.id,src:item.src,name:String(item.name || "自选背景").slice(0,80)});
      }
      return items;
    } catch {return [];}
  }
  async function save(bytes,name) {
    const maxBytes=options.maxBytes || 20*1024*1024;
    if(!bytes.length || bytes.length>maxBytes) throw Object.assign(new Error("每张背景图片最多 20 MB。"),{status:413});
    const ext=imageType(bytes);if(!ext) throw Object.assign(new Error("请选择 JPG、PNG、WebP 或 GIF 图片。"),{status:400});
    const operation=pending.catch(()=>{}).then(async()=>{
      const items=await list(),id=createHash("sha256").update(bytes).digest("hex"),existing=items.find(i=>i.id===id);
      if(existing) return {item:existing,added:false};
      if(items.length>=100) throw Object.assign(new Error("项目最多保存 100 张自选背景。"),{status:409});
      const filename=`custom-${id}.${ext}`,target=path.join(directory,filename);
      await fs.mkdir(directory,{recursive:true});
      try {await fs.writeFile(target,bytes,{flag:"wx"});}
      catch(err) {if(err.code!=="EEXIST") throw err;if(createHash("sha256").update(await fs.readFile(target)).digest("hex")!==id) throw Object.assign(new Error("背景文件冲突，请检查背景文件夹。"),{status:409});}
      const item={id,src:`assets/images/${filename}`,name:String(name || "自选背景").replace(/[\x00-\x1f\x7f]/g,"").replace(/\.[^.]+$/,"").trim().slice(0,80) || "自选背景"};
      const temp=path.join(directory,`.backgrounds-${randomUUID()}.tmp`);
      try {await fs.writeFile(temp,PREFIX+JSON.stringify([...items,item])+";\n",{flag:"wx"});await fs.rename(temp,manifest);}
      finally {await fs.unlink(temp).catch(()=>{});}
      return {item,added:true};
    });
    pending=operation;return operation;
  }
  return {list,save,flush:()=>pending.catch(()=>{})};
}
module.exports={createBackgroundStore,imageType};
