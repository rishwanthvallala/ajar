// Run a WASI preview 1 program under Node, as the pad's sandbox would run it.
//
//   node wasi-run.mjs <program.wasm> [--dir GUEST=HOST]... [--env K=V]... -- [args...]
//
// Standard input, output and error are this process's; the exit status is the
// program's. Used by java-fidelity.mjs to run the Java package's own atoms.
// The pad runs them under Wasmer rather than Node, so a difference only one
// of the two shows is worth a look in the pad itself (probe.html?files=).
import { WASI } from "node:wasi";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const program = args.shift();
const preopens = {};
const env = {};
while (args.length && args[0] !== "--") {
  const flag = args.shift();
  const value = args.shift() ?? "";
  const [k, ...rest] = value.split("=");
  if (flag === "--dir") preopens[k] = rest.join("=");
  else if (flag === "--env") env[k] = rest.join("=");
  else throw new Error(`unknown flag ${flag}`);
}
args.shift();

const wasi = new WASI({ version: "preview1", args: [program.replace(/^.*\//, ""), ...args], env, preopens, returnOnExit: true });
const module = await WebAssembly.compile(await readFile(program));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);
