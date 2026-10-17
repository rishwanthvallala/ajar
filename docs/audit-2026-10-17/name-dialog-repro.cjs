const fs = require('node:fs');
(async()=>{
const source=fs.readFileSync('pad/src/ui.ts','utf8');
const begin=source.indexOf('    let asked = 0;');
const end=source.indexOf('    input.addEventListener("input", judge);',begin);
const input={value:'taken'}, said={}, yes={}, jobs=[];
let resolve;
const opts={check:()=>new Promise(r=>resolve=r)};
const make=new Function('input','said','yes','opts','setTimeout','clearTimeout',require('node:module').stripTypeScriptTypes(source.slice(begin,end))+'\nreturn judge;');
const judge=make(input,said,yes,opts,cb=>{jobs.push(cb);return jobs.length;},()=>{});
judge();jobs.shift()();input.value='';judge();const before={value:input.value,disabled:yes.disabled,text:said.textContent};
resolve({free:false,why:'taken is already used'});await Promise.resolve();await Promise.resolve();
const after={value:input.value,disabled:yes.disabled,text:said.textContent};
const result={source:'pad/src/ui.ts:270-297',scenario:'Clear name while unavailable-name request is in flight',before,after,defect:input.value===''&&yes.disabled};
fs.writeFileSync('docs/audit-2026-10-17/name-dialog-repro.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})();

