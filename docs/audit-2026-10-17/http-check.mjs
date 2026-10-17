import {writeFile} from 'node:fs/promises';
const origin='https://code.rishwanth.dev';
const paths=['/','/healthz','/api/me','/api/my/pads','/admin','/privacy','/sw.js'];
const out=[];
for (const path of paths) {
 const start=performance.now();
 try {
  const r=await fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(20000)});
  const body=await r.text();
  out.push({path,status:r.status,ms:Math.round(performance.now()-start),headers:Object.fromEntries(r.headers),body:path==='/'||path==='/sw.js'?body:body.slice(0,800)});
 }catch(e){out.push({path,error:String(e)})}
}
await writeFile('docs/audit-2026-10-17/live-http.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(out.map(({body,...rest})=>({...rest,bodySnippet:body?.slice(0,180)})),null,2));
