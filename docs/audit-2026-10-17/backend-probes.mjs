// Local, bounded backend probes. Starts its own relay and temporary databases.
// Requires a freshly built target/debug/ajar-relay and target/audit-db-tool.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ajar-backend-audit-'));
const port = 18897;
const url = `http://127.0.0.1:${port}`;
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let relay;
const sockets = new Set();
const db = (which, sql) => execFileSync(join(root, 'target/audit-db-tool'), [join(dir, which), sql]);
function report(test, evidence) { const r = {test, ...evidence}; results.push(r); console.log(JSON.stringify(r)); }
async function start(extra = []) {
  relay = spawn(join(root, 'target/debug/ajar-relay'), ['--bind', `127.0.0.1:${port}`, '--pad-dir', join(dir,'pads'), '--accounts-db', join(dir,'accounts.db'), ...extra], {stdio: ['ignore', 'ignore', 'pipe'], env: {...process.env, AJAR_PUBLIC_ORIGIN:'http://127.0.0.1:18897', RUST_LOG:'error'}});
  relay.stderr.on('data', d => process.stderr.write(d));
  for (let i=0;i<100;i++) { try { if ((await fetch(url+'/healthz')).ok) return; } catch {} await sleep(50); }
  throw Error('relay did not start');
}
async function stop() { for (const s of sockets) s.destroy(); sockets.clear(); const p=relay; if (p && p.exitCode===null) { p.kill(); await new Promise(r=>p.once('exit',r)); } }
async function req(path, method='GET', body, headers={}) {
  const r=await fetch(url+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text(); let data;try{data=JSON.parse(text)}catch{data=text} return {status:r.status,data};
}
const put=(name,writes,headers={})=>req(`/api/pad/${name}`,'PUT',{writes},headers);
function rss() { const t=readFileSync(`/proc/${relay.pid}/status`,'utf8'); return Number(/VmRSS:\s+(\d+)/.exec(t)[1])/1024; }
function frame(channel, payload, target=0,stream=0){const b=Buffer.alloc(9+payload.length);b[0]=channel;b.writeUInt32LE(stream,1);b.writeUInt32LE(target,5);Buffer.from(payload).copy(b,9);return b;}
function masked(payload){const mask=randomBytes(4);const head=Buffer.alloc(payload.length<126?6:8);head[0]=0x82;if(payload.length<126){head[1]=0x80|payload.length;mask.copy(head,2)}else{head[1]=0x80|126;head.writeUInt16BE(payload.length,2);mask.copy(head,4)}const body=Buffer.from(payload);for(let i=0;i<body.length;i++)body[i]^=mask[i%4];return Buffer.concat([head,body]);}
async function peer(name,cookie,origin='http://127.0.0.1:18897',beforeHello){
  const s=net.connect(port,'127.0.0.1');sockets.add(s);s.on('error',e=>process.stderr.write(`socket: ${e.message}\n`));let buf=Buffer.alloc(0),up=false,id;const frames=[];
  s.on('data',chunk=>{buf=Buffer.concat([buf,chunk]);if(!up){const end=buf.indexOf('\r\n\r\n');if(end<0)return;const h=buf.subarray(0,end).toString();if(!h.includes('101'))throw Error(h);buf=buf.subarray(end+4);up=true;Promise.resolve(beforeHello?.()).then(()=>s.write(masked(frame(1,Buffer.from(JSON.stringify({t:'hello',session:name,role:'peer'}))))))}while(buf.length>=2){let n=buf[1]&127,off=2;if(n===126){if(buf.length<4)return;n=buf.readUInt16BE(2);off=4}else if(n===127){if(buf.length<10)return;n=Number(buf.readBigUInt64BE(2));off=10}if(buf.length<off+n)return;const b=buf.subarray(off,off+n);buf=buf.subarray(off+n);if(b.length>=9){frames.push(Buffer.from(b));if(b[0]===1){try{const c=JSON.parse(b.subarray(9));if(c.t==='welcome')id=c.participant_id}catch{}}}}});
  await new Promise(r=>s.once('connect',r));
  s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\n\r\n`);
  for(let i=0;i<100&&id===undefined;i++)await sleep(20);
  if(id===undefined)throw Error('no welcome '+frames.map(b=>b.subarray(9).toString()).join(';'));
  return {s,id,frames,send:payload=>s.write(masked(frame(5,Buffer.from(payload),id,123)))};
}
try{
 await start(['--max-store-bytes','1024']);
 report('empty_pad_bypasses_blob_ceiling',{create:await put('audit-empty',[]),lastRun:await req('/api/pad/audit-empty/run','PUT',{path:'main.py',command:'python main.py',exit:0,output:'x'.repeat(32768)}),note:'store ceiling 1024 bytes; retained output 32768 bytes'});
 await stop(); await start();

 // Only two unfinished requests, then release them. No production traffic.
 const slow=[];
 for(let i=0;i<2;i++){const s=net.connect(port,'127.0.0.1');sockets.add(s);s.on('error',()=>{});slow.push(s);await new Promise(r=>s.once('connect',r));s.write(`PUT /api/pad/audit-slow-${i} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{`)}
 await sleep(100); const began=Date.now(); let finished=false;const pending=put('audit-ordinary',[{path:'a.txt',content:'hello'}]).then(x=>{finished=true;return x});await sleep(2200);const blocked=!finished;slow.forEach(s=>s.destroy());const answer=await pending;report('two_incomplete_bodies_block_all_pad_writes',{blockedForMs:blocked?Date.now()-began:0,afterRelease:answer.status});

 for(const n of [2000,4000,8000]) {const t=performance.now();const r=await put('audit-many-deletes',Array.from({length:n},(_,i)=>({path:`absent-${String(i).padStart(6,'0')}`})));report('unbounded_write_operations',{n,status:r.status,ms:Math.round(performance.now()-t)});}

 const token='audit-local-session';const hash=createHash('sha256').update(token).digest('hex');const hash2=createHash('sha256').update(token+'-witness').digest('hex');const now=Math.floor(Date.now()/1000);const cookie=`ajar=${token}`;
 db('accounts.db',`INSERT INTO users (id,provider,provider_id,name,created) VALUES (1,'github','audit','Audit',${now}); INSERT INTO sessions VALUES (x'${hash}',1,${now},${now+3600}); INSERT INTO sessions VALUES (x'${hash2}',1,${now},${now+3600}); INSERT INTO pads (name,owner_id,view,edit,created) VALUES ('audit-private',1,'owner','owner',${now});`);
 const ownerHeaders={cookie};await put('audit-private',[{path:'secret.txt',content:'local test secret'}],ownerHeaders);
 const own=await peer('audit-private',cookie+'-witness');let other=await peer('audit-private',cookie,'https://preview.rishwanth.dev');const baseline=own.frames.length;other.send([1,41,42,43]);await sleep(100);
 report('websocket_accepts_sibling_origin_owner_cookie',{unauthenticatedHttp:(await req('/api/pad/audit-private')).status,wrongOriginWelcome:true,docForwarded:own.frames.slice(baseline).some(b=>b[0]===5&&b.subarray(9).equals(Buffer.from([1,41,42,43])))});
 other=await peer('audit-private',cookie,'http://127.0.0.1:18897',async()=>{await req('/auth/logout','POST',undefined,{cookie,'x-ajar':'1'})});const afterLogout=own.frames.length;other.send([1,61,62]);await sleep(100);report('hello_after_logout_retains_owner_grant',{httpAfterLogout:(await req('/api/pad/audit-private','GET',undefined,ownerHeaders)).status,lateOwnerJoined:true,docForwarded:own.frames.slice(afterLogout).some(b=>b[0]===5&&b.subarray(9).equals(Buffer.from([1,61,62])))});
 db('accounts.db','UPDATE sessions SET expires=0;');const beforeExpiry=other.frames.length;own.send([1,51,52]);await sleep(100);report('expired_session_keeps_socket_owner_privileges',{httpAfterExpiry:(await req('/api/pad/audit-private','GET',undefined,{cookie:cookie+'-witness'})).status,docForwarded:other.frames.slice(beforeExpiry).some(b=>b[0]===5&&b.subarray(9).equals(Buffer.from([1,51,52])))});
 own.s.destroy();other.s.destroy();
 db('accounts.db','ALTER TABLE pads RENAME TO pads_fault_injected;');const opened=await req('/api/pad/audit-private');const overwritten=await put('audit-private',[{path:'secret.txt',content:'anonymous write during account DB fault'}]);report('account_lookup_sql_failure_opens_private_pad',{status:opened.status,role:opened.data.access?.role,content:opened.data.files?.['secret.txt']?.content,unauthenticatedWrite:overwritten.status});db('accounts.db','ALTER TABLE pads_fault_injected RENAME TO pads;');

 await put('audit-history',[{path:'large.txt',content:'v'.repeat(8*1024*1024)}]);const kept=await req('/api/pad/audit-history/history','POST');const id=kept.data.id;
 const baselineRss=rss();let max=baselineRss;const sampling=setInterval(()=>max=Math.max(max,rss()),10);const histories=await Promise.all(Array.from({length:4},()=>req(`/api/pad/audit-history/history/${id}`)));clearInterval(sampling);report('history_reads_materialize_full_content',{versionMiB:8,concurrency:4,statuses:histories.map(r=>r.status),baselineRssMiB:+baselineRss.toFixed(1),peakRssMiB:+max.toFixed(1),growthMiB:+(max-baselineRss).toFixed(1)});
 db('pads/store.db',"UPDATE pads SET touched_ms=0 WHERE name='audit-history';");report('expired_pad_history_still_readable',{ordinaryRead:await req('/api/pad/audit-history'),history:(await req('/api/pad/audit-history/history')).status,oldVersion:(await req(`/api/pad/audit-history/history/${id}`)).status});
 await stop();renameSync(join(dir,'accounts.db'),join(dir,'accounts-missing.db'));await start();const lost=await req('/api/pad/audit-private');report('missing_account_database_exposes_stored_private_pad',{status:lost.status,role:lost.data.access?.role,content:lost.data.files?.['secret.txt']?.content});
}finally{await stop();const safe=resolve(dir);if(!safe.startsWith(resolve(tmpdir())+'/ajar-backend-audit-'))throw Error('unsafe cleanup');rmSync(safe,{recursive:true,force:true});}
