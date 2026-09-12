/// <reference types="vite/client" />

/** Vite's `?raw` import, which has no type of its own. */
declare module "*.py?raw" {
  const source: string;
  export default source;
}
