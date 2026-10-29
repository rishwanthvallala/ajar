/**
 * The completer as Monaco inline suggestions: grey text at the cursor, Tab to
 * take it, Escape or typing on to leave it.
 *
 *   const off = attachCompleter(monaco, editor, completer, { enabled: (model) => … });
 *
 * What it adds to a bare `complete()` call:
 *
 * - The code around the cursor, cut where the prompt needs it: from the start
 *   of a line about 8,000 characters up, to about 8,000 characters down, with
 *   line breaks as `\n` whatever the file uses.
 * - Typing what is shown keeps the rest of it on screen without asking again.
 * - A cursor that lands somewhere new — a click, an arrow key, a file opened —
 *   has its prompt run into the cache once it rests, so the first keystroke
 *   there is answered as fast as the next.
 * - Closing brackets already after the cursor are not suggested twice: the
 *   model was trained to write them, and the editor has them.
 */
import type * as Monaco from "monaco-editor";
import type { Completer, Completion, Request } from "./index";

export interface AttachOptions {
  /** Asked before every request: false shows nothing and runs nothing. Default: anything but plain text. */
  enabled?(model: Monaco.editor.ITextModel): boolean;
  /** Each completion the model made, and whether it was sure enough to show. */
  onCompletion?(c: Completion, shown: boolean): void;
}

const PREFIX_CHARS = 8000;
const SUFFIX_CHARS = 8000;
/** A cursor at rest this long after moving has its prompt prepared. */
const SETTLE_MS = 120;

type Api = typeof Monaco;

export function attachCompleter(monaco: Api, editor: Monaco.editor.ICodeEditor, completer: Completer, o: AttachOptions = {}): Monaco.IDisposable {
  const enabled = o.enabled ?? ((m: Monaco.editor.ITextModel) => m.getLanguageId() !== "plaintext");
  // What was last shown, so typing it can be answered from here.
  let shown: { uri: string; line: number; before: string; after: string; text: string } | null = null;

  const provider: Monaco.languages.InlineCompletionsProvider = {
    displayName: "pad",
    // The worker drops a request the next one overtakes, and a warm one takes
    // about 10 ms, so waiting first would only add to every suggestion.
    debounceDelayMs: 0,
    async provideInlineCompletions(model, position, context, token) {
      if (!enabled(model) || context.selectedSuggestionInfo) return;
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);
      const after = line.slice(position.column - 1);
      const uri = model.uri.toString();
      const at = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
      if (shown && shown.uri === uri && shown.line === position.lineNumber && shown.after === after && before.startsWith(shown.before)) {
        const typed = before.slice(shown.before.length);
        if (shown.text.startsWith(typed) && typed.length < shown.text.length) {
          return { items: [{ insertText: shown.text.slice(typed.length), range: at }] };
        }
      }
      shown = null;
      const ac = new AbortController();
      const sub = token.onCancellationRequested(() => ac.abort());
      try {
        const c = await completer.complete(request(monaco, model, position), ac.signal);
        if (!c || token.isCancellationRequested) return;
        const ok = completer.shows(c);
        o.onCompletion?.(c, ok);
        if (!ok) return { items: [] };
        // What is already after the cursor on this line — often brackets
        // the editor closed — and the model writes again: either at the end
        // of what it suggests, which then goes in before them, or at the
        // start, when it rewrites them (`):` with `)` there), which then
        // replaces them. Either way the line ends as the model wrote it.
        let text = c.text;
        let range = at;
        const tail = after.trimEnd();
        if (tail && text.endsWith(tail)) text = text.slice(0, text.length - tail.length);
        else if (tail && text.startsWith(tail)) range = { ...at, endColumn: at.endColumn + tail.length };
        if (!text.trim()) return { items: [] };
        if (range === at) shown = { uri, line: position.lineNumber, before, after, text };
        return { items: [{ insertText: text, range }] };
      } finally {
        sub.dispose();
      }
    },
    disposeInlineCompletions() {},
  };
  const registration = monaco.languages.registerInlineCompletionsProvider("*", provider);
  // Ctrl+Right (⌘→ on a Mac) moves by a word, and the end of the line: Monaco
  // also has it take the next word of the grey text, which then went into a
  // shared file with no Tab pressed, for everyone (review of 28 October,
  // "med" taking "ian"). Tab takes a suggestion; nothing else does.
  const unbound = monaco.editor.addKeybindingRule({
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow,
    command: "-editor.action.inlineSuggest.acceptNextWord",
  });

  let settle: ReturnType<typeof setTimeout> | undefined;
  const moved = editor.onDidChangeCursorPosition((e) => {
    clearTimeout(settle);
    // Typing moves the cursor too, with reason NotSet; that is the provider's.
    if (e.reason === monaco.editor.CursorChangeReason.NotSet) return;
    settle = setTimeout(() => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (model && position && enabled(model) && !editor.getOption(monaco.editor.EditorOption.readOnly)) {
        completer.prepare(request(monaco, model, position));
      }
    }, SETTLE_MS);
  });
  const typed = editor.onDidChangeModelContent(() => clearTimeout(settle));

  return {
    dispose() {
      clearTimeout(settle);
      unbound.dispose();
      registration.dispose();
      moved.dispose();
      typed.dispose();
    },
  };
}

/** The request for a cursor: whole lines before it, up to about PREFIX_CHARS, and what follows it. */
export function request(monaco: Api, model: Monaco.editor.ITextModel, position: Monaco.IPosition): Request {
  const LF = monaco.editor.EndOfLinePreference.LF;
  const off = model.getOffsetAt(position);
  const first = model.getPositionAt(Math.max(0, off - PREFIX_CHARS)).lineNumber;
  let prefix = model.getValueInRange({ startLineNumber: first, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column }, LF);
  let line = first;
  // One enormous line — minified code — is cut mid-line rather than sent whole.
  if (prefix.length > 4 * PREFIX_CHARS) {
    prefix = prefix.slice(-PREFIX_CHARS);
    line = -1;
  }
  const last = model.getPositionAt(off + SUFFIX_CHARS).lineNumber;
  let suffix = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: last, endColumn: model.getLineMaxColumn(last) }, LF);
  if (suffix.length > 4 * SUFFIX_CHARS) suffix = suffix.slice(0, SUFFIX_CHARS);
  return { key: model.uri.toString(), line, prefix, suffix };
}
