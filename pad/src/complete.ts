import type * as Monaco from "monaco-editor";
import { Suggestions as Shared } from "@ajar/workspace-ui/suggest";

/**
 * Suggestions as you type, the pad's: @ajar/workspace-ui's (suggest.ts), told
 * whether this build has the model. A build without it (no ajar-complete.json
 * in its packages) has no switch at all: `__SUGGEST__`, from vite.config.ts.
 */
declare const __SUGGEST__: boolean;

export class Suggestions extends Shared {
  constructor(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor, button: HTMLButtonElement) {
    super(monaco, editor, button, { prefix: "pad", available: __SUGGEST__ });
  }
}
