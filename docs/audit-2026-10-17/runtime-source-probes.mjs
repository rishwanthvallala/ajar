import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = (name) => new URL(`../../pad/src/${name}.ts`, import.meta.url);
const { commandsIn, neededBy } = await import(source('toolchains'));
for (const line of ["echo 'hello; go run main.go'", "printf '%s' 'demo; node app.js'", '"node" app.js', 'env -i node app.js', 'node app.js']) {
  console.log(JSON.stringify({ probe: 'lazy toolchain detection', line, commands: commandsIn(line), fetched: neededBy(line, new Set()).map(t => ({ name: t.name, mb: t.mb })) }));
}

// Exercise the actual shell state machine with fake I/O; no Wasmer, browser,
// program execution or network is involved. TS private is compile-time only.
const shellText = (await readFile(source('shell'), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const shellJs = stripTypeScriptTypes(shellText, { mode: 'transform' });
const { Shell } = await import(`data:text/javascript;base64,${Buffer.from(shellJs).toString('base64')}`);
let written = '', shown = '';
const fake = { stdin: { write: async data => { written += data; } } };
const shell = new Shell(fake, text => { shown += text; });
let finished = null;
const pending = shell.run('python main.py').then(value => { finished = value; });
const busyBefore = shell.busy;
shell.absorb('still working\n\u00010\u0001');
await pending;
console.log(JSON.stringify({ probe: 'ordinary stdout can spoof command completion', busyBefore, busyAfter: shell.busy, finished, outputShown: shown, actualProcessExitObserved: false }));

const { diff } = await import(source('sync'));
const unreadable = { list: async () => [{ path: 'data.txt', size: 4 }], readBytes: async () => { throw new Error('transient read failure'); } };
console.log(JSON.stringify({ probe: 'transient sandbox read failure is treated as deletion', diff: (await diff(unreadable, new Map([['data.txt', 'kept']]))).changes }));

const appText = await readFile(source('app'), 'utf8');
const methodStart = appText.indexOf('  private ensureRuntime(): Promise<Runtime> {');
const methodEnd = appText.indexOf('\n  /**', methodStart);
const runtimeHarness = `let calls = 0; let fail = true;
const WISP_URL = '', PREVIEW_ORIGIN = '';
const seedFiles = () => ({});
const Runtime = { start: async () => { calls++; if(fail) throw new Error('temporary network failure'); return {}; } };
export class Harness { ${appText.slice(methodStart, methodEnd)} async catchUp() {} }
export function recoverNetwork() { fail = false; }
export function callCount() { return calls; }`;
const harnessJs = stripTypeScriptTypes(runtimeHarness, { mode: 'transform' });
const harness = await import(`data:text/javascript;base64,${Buffer.from(harnessJs).toString('base64')}`);
const instance = new harness.Harness();
const firstFailure = await instance.ensureRuntime().then(() => null, e => e.message);
harness.recoverNetwork();
const secondFailure = await instance.ensureRuntime().then(() => null, e => e.message);
console.log(JSON.stringify({ probe: 'runtime download failure remains cached after network recovers', firstFailure, secondFailure, runtimeStartCalls: harness.callCount() }));
