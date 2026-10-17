// Bounded invocation of the existing perf harness, with an isolated, verified
// scratch profile. No harness assertions or product code are changed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const logs = path.join(__dirname, 'logs');
const temp = path.resolve(os.tmpdir());
const profile = path.join(temp, 'ajar-audit-20261017-pad-perf-' + crypto.randomUUID().replaceAll('-', ''));
fs.mkdirSync(profile);
const real = fs.realpathSync(profile);
if (real !== profile || !real.toLowerCase().startsWith((temp + path.sep).toLowerCase()) || !/^ajar-audit-20261017-pad-perf-[0-9a-f]{32}$/.test(path.basename(real)) || fs.readdirSync(real).length) throw Error('Refusing unverified/nonempty perf profile');
fs.writeFileSync(path.join(logs, 'perf-profile-path.txt'), real + '\n');
console.log(JSON.stringify({ verifiedEmptyScratchProfile: real }));
const fd = fs.openSync(path.join(logs, 'pad-visit.log'), 'w');
const started = new Date().toISOString();
const deadlineMs = 450000;
const child = cp.spawn(process.execPath, ['--import', './docs/audit-2026-10-17/windows-test-adapter.mjs', 'scripts/perf/pad-visit.mjs'], {
  cwd: root,
  env: { ...process.env, COLD: '5000', WARM: '3000', PIP: '0', PROFILE: profile, OUT: path.join(logs, 'pad-visit.jsonl') },
  windowsHide: true,
  stdio: ['ignore', fd, fd],
});
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}, deadlineMs);
child.on('error', e => { clearTimeout(timer); fs.closeSync(fd); console.error(e.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  clearTimeout(timer); fs.closeSync(fd);
  const result = { harness: 'scripts/perf/pad-visit.mjs', started, ended: new Date().toISOString(), COLD: '5000', WARM: '3000', PIP: '0', profile, deadlineMs, timedOut, exitCode: code, signal, browser: 'installed Microsoft Edge via existing environment-only adapter', samples: 'one cold and one warm requested; any incomplete sample must be excluded' };
  fs.writeFileSync(path.join(logs, 'pad-visit-run.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  process.exitCode = timedOut ? 124 : code || 0;
});
