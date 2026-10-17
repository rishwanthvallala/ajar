import {writeFile} from 'node:fs/promises';
const url='https://code.rishwanth.dev/assets/problems-CVQixfdG.js';
const r=await fetch(url,{signal:AbortSignal.timeout(30000)});const text=await r.text();
await writeFile('docs/audit-2026-10-17/live-problems-CVQixfdG.js',text);console.log(JSON.stringify({url,status:r.status,bytes:text.length}));
