/// <reference types="vite/client" />

/** Vite's `?raw` import, which has no type of its own. */
declare module "*.py?raw" {
  const source: string;
  export default source;
}

/** `y-protocols` ships its own types but not for this subpath in every setup. */
declare module "y-protocols/awareness" {
  export class Awareness {
    constructor(doc: unknown);
    clientID: number;
    setLocalStateField(field: string, value: unknown): void;
    getStates(): Map<number, unknown>;
    on(event: string, fn: (...args: never[]) => void): void;
    off(event: string, fn: (...args: never[]) => void): void;
    destroy(): void;
  }
  export function applyAwarenessUpdate(a: Awareness, update: Uint8Array, origin: unknown): void;
  export function encodeAwarenessUpdate(a: Awareness, changed: number[]): Uint8Array;
  export function removeAwarenessStates(a: Awareness, clients: number[], origin: unknown): void;
}

interface ImportMetaEnv {
  readonly VITE_PREVIEW_ORIGIN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
