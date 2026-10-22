/**
 * One thread of the engine's pool: the worker's module, instantiated again on
 * the same shared memory with a stack of its own, then handed to the pool's
 * loop, which never returns. It sleeps on a futex when there is no work, so
 * an idle pool costs nothing.
 */
import { wasi } from "./engine";

interface PoolExports {
  __stack_pointer: WebAssembly.Global;
  worker_stack(tid: number): number;
  worker_entry(tid: number): void;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ module: WebAssembly.Module; memory: WebAssembly.Memory; tid: number }>) => void) | null;
  postMessage(m: string): void;
};
scope.onmessage = async (e) => {
  const { module, memory, tid } = e.data;
  let x: PoolExports;
  try {
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi(() => memory, () => {}),
      env: { memory },
    });
    x = instance.exports as unknown as PoolExports;
    x.__stack_pointer.value = x.worker_stack(tid);
  } catch (err) {
    // Said rather than thrown: a rejection here never reaches the worker's
    // `error` event, and the pool would wait for this thread until it gave up.
    scope.postMessage(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  scope.postMessage("ready");
  x.worker_entry(tid);
};
