import {readFile,writeFile} from 'node:fs/promises';
const orig='https://code.rishwanth.dev';
const http=JSON.parse(await readFile('docs/audit-2026-10-17/live-http.json','utf8'));
const html=http.find(x=>x.path==='/').body;
const index=html.match(/src="(\/assets\/index[^\"]+\.js)"/)[1];
const r=await fetch(orig+index);const src=await r.text();
const files=[...new Set([...src.matchAll(/(?:\.\/|\/assets\/)?((?:bootstrap|dashboard|style)[\w-]*\.js)/g)].map(x=>x[1]))];
const result={index,bytes:src.length,files,checks:[]};
for(const f of files){const u=orig+'/assets/'+f;const r=await fetch(u);const s=await r.text();await writeFile('docs/audit-2026-10-17/live-'+f,s);result.checks.push({url:u,status:r.status,bytes:s.length,shellJsonQuote:s.includes('JSON.stringify(this.active)'),beforeUnload:s.includes('beforeunload'),noStore:s.includes('no-store')});}
const swr=await fetch('https://preview.rishwanth.dev/wasmer-service-worker.js');const sw=await swr.text();await writeFile('docs/audit-2026-10-17/live-preview-sw.js',sw);result.previewSw={status:swr.status,matchesSource:sw===(await readFile('pad/preview/sw.js','utf8')).replaceAll('\r\n','\n')};
await writeFile('docs/audit-2026-10-17/deployment-parity.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));

