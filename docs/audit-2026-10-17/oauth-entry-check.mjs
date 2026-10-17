import {writeFile} from 'node:fs/promises';
const results=[];
for(const provider of ['google','github']){
 const r=await fetch(`https://code.rishwanth.dev/auth/${provider}/start?next=%2Fdashboard`,{redirect:'manual',signal:AbortSignal.timeout(15000)});
 const loc=r.headers.get('location'); const u=loc?new URL(loc):null; const cookie=r.headers.get('set-cookie')??'';
 results.push({provider,status:r.status,destination:u?.origin,scope:u?.searchParams.get('scope'),redirect_uri:u?.searchParams.get('redirect_uri'),statePresent:!!u?.searchParams.get('state'),pkceMethod:u?.searchParams.get('code_challenge_method'),cookieAttributes:cookie.split(';').slice(1).map(x=>x.trim())});
}
await writeFile('docs/audit-2026-10-17/oauth-entry-check.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
