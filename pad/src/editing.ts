import type * as monaco from "monaco-editor";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { asEditorHolds, eolOf, withEol } from "@ajar/workspace-ui/eol";
import { wholeCharacters } from "./carry";

export { asEditorHolds, eolOf, withEol };

/**
 * Collaborative editing bound to Monaco.
 *
 * Lifted from ajar's session client, which has carried it for months. The
 * difference here is who it talks to: there it reaches a host that owns a
 * disk, and here it reaches the other browsers directly, with the store
 * holding the durable copy underneath.
 *
 * Written here rather than pulled from `y-monaco`, which has not been
 * published since 2024 and predates this Monaco by several major versions.
 * The binding is small enough that owning it costs less than tracking a stale
 * dependency, and cursor rendering is the part you always end up customising.
 */

const COLOURS = [
  "#2447c9",
  "#9e5a15",
  "#1c6a4b",
  "#a63a2a",
  "#5b3fa8",
  "#0f6b63",
  "#8a5a0b",
  "#7a2f5f",
];

export function colourFor(id: number): string {
  return COLOURS[id % COLOURS.length] ?? COLOURS[0]!;
}

/**
 * A participant id from somebody else's awareness state, or null.
 *
 * Everything in that state comes from another browser, unchecked, and the id
 * is written into a stylesheet and a class name — `1 { } body { display: none }`
 * was accepted as one. The relay issues non-negative integers, so nothing else
 * is an id.
 */
export function participantId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}


/**
 * A name, safe to drop inside a CSS string.
 *
 * `replace(/"/g, "")` is not enough, and this is reachable: names are chosen
 * by whoever joins. A trailing backslash escapes the closing quote, the string
 * runs on, and the rest of the stylesheet becomes theirs to write — which buys
 * defacement and, through `url()` on an attribute selector, a way to send what
 * is on screen somewhere else.
 *
 * So backslashes and quotes are escaped, and anything below 0x20 goes out as a
 * hex escape, since a raw newline ends a CSS string whatever else is done to
 * it. The trailing space is part of CSS hex-escape syntax: it terminates the
 * escape so a following digit is not swallowed into it.
 */
export function cssString(text: string): string {
  return text.replace(/[\\"\u0000-\u001f]/g, (ch) => {
    if (ch === "\\" || ch === '"') return "\\" + ch;
    return "\\" + ch.charCodeAt(0).toString(16) + " ";
  });
}

/**
 * Bytes of a model's text as UTF-8, a line at a time. Encoding the whole text
 * instead made it one 20 MB string and a 21 MB buffer, and every switch back
 * to that file was 18 ms slower afterwards (11 October).
 */
export function utf8Of(model: monaco.editor.ITextModel): number {
  const lines = model.getLineCount();
  let bytes = model.getEOL().length * (lines - 1);
  for (let i = 1; i <= lines; i++) {
    const line = model.getLineContent(i);
    bytes += line.length;
    if (!NOT_ASCII.test(line)) continue;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      // Two bytes below U+0800, three above; a surrogate pair is four for its two.
      if (c >= 0x80) bytes += c < 0x800 || (c >= 0xd800 && c <= 0xdfff) ? 1 : 2;
    }
  }
  return bytes;
}

const NOT_ASCII = /[^\x00-\x7f]/;

/**
 * The client id a text is seeded under: FNV-1a of it, never the 0 a seed
 * used before. Two seeds share one only when their text is the same.
 *
 * 64-bit FNV-1a, folded to the 53 bits a JavaScript number holds exactly,
 * since 18 October. It was the 32-bit one, and 32 bits of anything collide
 * within a few tens of thousands of texts: seeded with `file-1ezsubx.txt` and
 * `file-6yp6oj.txt`, two documents shared one id, swapped updates and stayed
 * different, and `foreignRoot` saw nothing foreign (audit of 17 October,
 * DC-09). Yjs writes a client id as a variable-length integer, which carries
 * 53 bits as well as 32. A page from before seeds the same text under the
 * old id, which a page from after takes for a second history and rejoins
 * from, as it does any other.
 *
 * Done in 16-bit pieces rather than with BigInt: a seed hashes the whole
 * file, and over 20 MB BigInt took 411 ms where this takes 43, about what
 * the 32-bit hash took (18 October).
 */
export function seedId(text: string): number {
  // The offset basis 0xcbf29ce484222325, low piece first.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < text.length; i++) {
    h0 ^= text.charCodeAt(i);
    // Times the prime 0x100000001b3: 0x1b3, and 1 shifted 40 bits — which
    // is the low two pieces moved up by two and 8 bits more.
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + (t1 >>> 16) + ((h0 << 8) & 0xffffff);
    const t3 = h3 * 0x1b3 + (t2 >>> 16) + ((h1 << 8) & 0xffffff);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  // The top eleven bits folded into the bottom, as FNV's authors suggest for
  // fewer bits than the hash has.
  const top = h3 >>> 5;
  const id = (h3 & 0x1f) * 2 ** 48 + h2 * 2 ** 32 + h1 * 2 ** 16 + (h0 ^ top);
  return id || 1;
}


/** One open file, shared. */
export class DocSession {
  readonly ydoc = new Y.Doc();
  readonly ytext: Y.Text;
  readonly awareness: Awareness;
  private binding: (() => void) | null = null;
  private applyingRemote = false;
  /** Seeded from a stored copy that was empty: nothing to insert, and still the truth. */
  private seededEmpty = false;
  /** The text this document was seeded with, and when — what its own history starts from. */
  seededWith: { text: string; at: number } | null = null;
  private readonly views = new Map<monaco.editor.IStandaloneCodeEditor, { model: monaco.editor.ITextModel; decorations: monaco.editor.IEditorDecorationsCollection; dispose: () => void }>();
  private boundModel: monaco.editor.ITextModel | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private api: typeof monaco | null = null;

  constructor(
    readonly docId: number,
    readonly path: string,
    readonly me: { id: number; name: string },
    /** Send bytes for this document up to the host. */
    private send: (kind: "update" | "awareness", bytes: Uint8Array) => void,
  ) {
    this.ytext = this.ydoc.getText("content");
    this.awareness = new Awareness(this.ydoc);
    this.awareness.setLocalStateField("user", { id: me.id, name: me.name });

    this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      // Updates that arrived from the host are already everywhere they need
      // to be; echoing them would be a loop.
      if (origin === "remote") return;
      this.send("update", update);
    });

    this.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin === "remote") return;
      const changed = [...(added ?? []), ...(updated ?? []), ...(removed ?? [])];
      if (changed.length) {
        this.send("awareness", encodeAwarenessUpdate(this.awareness, changed));
      }
    });
  }

  /** Whether an editor is showing this document right now. */
  get bound(): boolean {
    return this.binding !== null;
  }

  /**
   * Put new text in place of all of it, as an edit of this browser's — so it
   * reaches everyone else in the room, as typing does. For a file replaced
   * from outside the editor: a zip's version of it.
   */
  replace(text: string) {
    // Only the stretch that differs, as `replaceText` does for a model: a
    // delete-everything-and-insert reached everyone with the file open as a
    // whole new file, and sent them back to its first line.
    const old = this.ytext.toString();
    // In the document's line ending — a command's output is whatever it is,
    // and an editor would have converted it, putting every later edit off.
    text = withEol(text, eolOf(old) ?? "\n");
    if (old === text) return;
    const limit = Math.min(old.length, text.length);
    let start = 0;
    while (start < limit && old.charCodeAt(start) === text.charCodeAt(start)) start++;
    let end = 0;
    while (end < limit - start && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
    [start, end] = wholeCharacters(old, start, end);
    [start, end] = wholeCharacters(text, start, end);
    this.ydoc.transact(() => {
      const gone = old.length - end - start;
      if (gone > 0) this.ytext.delete(start, gone);
      const added = text.slice(start, text.length - end);
      if (added) this.ytext.insert(start, added);
    }, "local");
  }

  /**
   * Remove `remove` characters at `at` and put `insert` there, as an edit of
   * this browser's — for a change made outside the editor, to a document
   * not on screen. In the document's line ending, as `replace` is.
   */
  edit(at: number, remove: number, insert: string) {
    const text = withEol(insert, eolOf(this.ytext.toString()) ?? "\n");
    this.ydoc.transact(() => {
      if (remove > 0) this.ytext.delete(at, remove);
      if (text) this.ytext.insert(at, text);
    }, "local");
  }

  /** Several literal replacements, as one local transaction. Descending offsets stay valid. */
  editMany(edits: readonly { at: number; remove: number; insert: string }[]): void {
    const eol = eolOf(this.ytext.toString()) ?? "\n";
    this.ydoc.transact(() => {
      for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
        if (edit.remove) this.ytext.delete(edit.at, edit.remove);
        if (edit.insert) this.ytext.insert(edit.at, withEol(edit.insert, eol));
      }
    }, "local");
  }

  /** The text as it stands. */
  contents(): string {
    return this.ytext.toString();
  }

  /** What this document already has, so a peer can send only the rest. */
  stateVector(): Uint8Array {
    return Y.encodeStateVector(this.ydoc);
  }

  /** Everything the holder of `vector` is missing. */
  diffSince(vector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc, vector);
  }

  /** How much text there is, without materialising it. */
  get length(): number {
    return this.ytext.length;
  }

  /**
   * Put the stored text in.
   *
   * Seeded under a client id made from the text, which is what makes this
   * safe to do more than once. A CRDT identifies every character by the
   * client that inserted it, so two browsers seeding the same string as
   * themselves produce two distinct insertions and the merge keeps both — the
   * file silently doubles. Seeded under the same id, the operations are
   * byte-identical and merging them is a no-op.
   *
   * From the text rather than a fixed 0, as it was until 4 October: two
   * seeds of *different* text under one id are two documents claiming the
   * same characters, and Yjs, taking each for one it already has, puts later
   * edits against the wrong ones — garbled text, with nothing to notice. A
   * viewer meets exactly that: it keeps a document whose editors have left,
   * and the next editor seeds again from the stored copy. With an id per
   * text, the stranger's edits build on characters this document has never
   * seen, and wait as unplaceable — which a viewer notices and repairs (see
   * `App.unstick`).
   *
   * The id is restored immediately: real edits must be attributable, or two
   * people typing would collide in the same way.
   *
   * Origin `remote` so this neither broadcasts nor marks the file unsaved —
   * every peer reaches this state on its own, from a copy the server already
   * has.
   */
  seed(text: string) {
    // As an editor holds it. Every place converts the same text the same way,
    // so the seeds still match; the stored copy takes the converted text at
    // the next save.
    text = asEditorHolds(text);
    if (this.ytext.length > 0) return;
    this.seededWith = { text, at: Date.now() };
    if (!text) {
      this.seededEmpty = true;
      return;
    }
    const mine = this.ydoc.clientID;
    this.ydoc.clientID = seedId(text);
    try {
      this.ydoc.transact(() => this.ytext.insert(0, text), "remote");
    } finally {
      this.ydoc.clientID = mine;
    }
  }

  applyUpdate(bytes: Uint8Array) {
    Y.applyUpdate(this.ydoc, bytes, "remote");
  }

  /**
   * The client of a history in `update` that shares nothing with this one,
   * or null.
   *
   * A document starts with one insert that has nothing to its left or right:
   * the seed. An update carrying such an insert from a client this document
   * has never heard of, when this one already holds text, is a second
   * document of the same file — seeded from the stored copy by somebody who
   * asked while the place holding the live one could not answer: asleep, or
   * between networks. Merged, a CRDT keeps both, and the file doubled for
   * everyone.
   */
  foreignRoot(update: Uint8Array): number | null {
    if (this.ytext.length === 0) return null;
    for (const struct of Y.decodeUpdate(update).structs) {
      if (!(struct instanceof Y.Item)) continue;
      if (this.ydoc.store.clients.has(struct.id.client)) continue;
      if (struct.origin === null && struct.rightOrigin === null) return struct.id.client;
    }
    return null;
  }

  /** The client of this document's own first insert, if it has one. */
  get rootClient(): number | null {
    for (let item = this.ytext._start; item; item = item.right) {
      if (item.origin === null && item.rightOrigin === null) return item.id.client;
    }
    return null;
  }

  /**
   * Whether this holds somebody's document yet, rather than an update it
   * could do nothing with. A newcomer hears other people's traffic about a
   * file — the diffs they swap whenever somebody joins, a keystroke — before
   * the answer to its own request: a fragment whose history it has not seen
   * waits as pending, an empty diff adds nothing, and either way the text is
   * still empty.
   */
  get hasState(): boolean {
    return this.ydoc.store.clients.size > 0 && this.ydoc.store.pendingStructs === null;
  }

  /**
   * Whether this is the file's text, to be edited and built on: somebody's
   * state, or a stored copy that was empty. `hasState` alone said no to the
   * second — an empty seed inserts nothing — so a new file a command then
   * wrote kept an empty document, and opened empty, with the command's
   * output in the store and nowhere on screen.
   */
  get ready(): boolean {
    return this.hasState || (this.seededEmpty && this.ydoc.store.pendingStructs === null);
  }

  /**
   * Who this browser is now. The relay issues a new id on every reconnect,
   * and the id is the colour: without this a document opened before a
   * reconnect went on showing everyone else the old one.
   */
  /**
   * Holding updates it cannot place, because what they build on never
   * arrived. Briefly, while traffic is in flight, that is normal; for long,
   * this document has a history the room's no longer shares.
   */
  get stuck(): boolean {
    return this.ydoc.store.pendingStructs !== null;
  }

  setUser(user: { id: number; name: string }) {
    this.awareness.setLocalStateField("user", user);
  }

  /**
   * Drop the cursors of people no longer here.
   *
   * A closed tab never says goodbye to the document, and Yjs keeps a silent
   * peer's cursor for thirty seconds, so someone who had left went on showing
   * a cursor, in a colour no dot in the header had any more. The relay knows
   * at once who has left; this takes its word for it.
   */
  keepOnly(present: Set<number>) {
    const gone: number[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue;
      const user = (state as { user?: { id: number } }).user;
      if (user && !present.has(user.id)) gone.push(clientId);
    }
    if (gone.length) removeAwarenessStates(this.awareness, gone, "remote");
  }

  applyAwareness(bytes: Uint8Array) {
    applyAwarenessUpdate(this.awareness, bytes, "remote");
  }

  /** Compatibility wrapper for single-view callers. */
  bind(api: typeof monaco, editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel) {
    const unbind = this.bindModel(api, model);
    const detach = this.attachView(editor, model);
    return () => { detach(); unbind(); };
  }

  /** Exactly one text binding, regardless of the number of editor views. */
  bindModel(api: typeof monaco, model: monaco.editor.ITextModel) {
    if (this.boundModel === model && this.binding) return this.binding;
    this.binding?.();
    this.boundModel = model;
    this.api = api;
    // The document is the truth; the model starts from it — in the document's
    // line ending, which the model would otherwise impose its own over.
    const text = this.ytext.toString();
    const eol = eolOf(text) ?? "\n";
    if (model.getEOL() !== eol) {
      model.setEOL(eol === "\r\n" ? api.editor.EndOfLineSequence.CRLF : api.editor.EndOfLineSequence.LF);
    }
    replaceText(api, model, text);
    // Still not the same: the document has mixed line endings — made by a
    // page from before this was handled, or written in from outside. Made
    // into what the editor can hold before anything is typed against it.
    if (model.getValue() !== text) this.mend(api, model);

    const onRemote = (event: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.origin === model) return;
      this.applyingRemote = true;
      try {
        // Applied one operation at a time against the live model, with the
        // index tracking the resulting text. Batching them would mean every
        // offset after the first was computed against the wrong document.
        let index = 0;
        for (const op of event.delta) {
          if (op.retain != null) {
            index += op.retain;
          } else if (op.insert != null) {
            const text = op.insert as string;
            const at = model.getPositionAt(index);
            model.applyEdits([
              { range: api.Range.fromPositions(at, at), text, forceMoveMarkers: true },
            ]);
            index += text.length;
          } else if (op.delete != null) {
            const from = model.getPositionAt(index);
            const to = model.getPositionAt(index + op.delete);
            model.applyEdits([{ range: api.Range.fromPositions(from, to), text: "" }]);
          }
        }
      } finally {
        this.applyingRemote = false;
      }
      // A line ending the model converted on the way in: an older page, or a
      // command's output written in somewhere that did not convert it. The
      // two would drift apart from here, so the document is mended first.
      if (model.getValueLength() !== this.ytext.length) queueMicrotask(() => this.mend(api, model));
    };
    this.ytext.observe(onRemote);

    const onLocal = model.onDidChangeContent((event) => {
      if (this.applyingRemote) return;
      this.ydoc.transact(() => {
        // Monaco reports changes in descending offset order, which is exactly
        // what keeps earlier offsets valid as we apply them.
        for (const change of event.changes) {
          if (change.rangeLength > 0) {
            this.ytext.delete(change.rangeOffset, change.rangeLength);
          }
          if (change.text) {
            this.ytext.insert(change.rangeOffset, change.text);
          }
        }
      }, model);
    });

    const binding = () => {
      if (this.binding !== binding) return;
      this.binding = null;
      this.boundModel = null;
      this.ytext.unobserve(onRemote);
      onLocal.dispose();
      for (const view of [...this.views.values()]) view.dispose();
    };
    this.binding = binding;
    return binding;
  }

  /** Cursor and decorations belong to a view, never to the shared text binding. */
  attachView(editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel) {
    const old = this.views.get(editor);
    if (old?.model === model) return old.dispose;
    old?.dispose();
    const onCursor = editor.onDidChangeCursorSelection(() => {
      if (!editor.hasTextFocus() || editor.getModel() !== model) return;
      const sel = editor.getSelection();
      if (!sel) return;
      const start = model.getOffsetAt(sel.getStartPosition());
      const end = model.getOffsetAt(sel.getEndPosition());
      this.awareness.setLocalStateField("cursor", { index: start, length: end - start });
    });
    const onAwareness = () => this.drawCursors(model);
    const dispose = () => {
      if (this.views.get(editor)?.dispose !== dispose) return;
      this.views.get(editor)?.decorations.clear();
      this.views.delete(editor);
      onCursor.dispose();
      this.awareness.off("change", onAwareness);
      if (!this.views.size) { this.styleEl?.remove(); this.styleEl = null; this.awareness.setLocalStateField("cursor", null); }
    };
    this.views.set(editor, { model, decorations: editor.createDecorationsCollection([]), dispose });
    this.awareness.on("change", onAwareness);
    this.drawCursors(model);
    return dispose;
  }

  /**
   * Make a document with mixed line endings into one an editor can hold, and
   * the editor match it.
   *
   * LF, by deleting carriage returns: deletions alone, so two places mending
   * at once agree — each deletes the same characters, and a character is
   * deleted once however many delete it. Converting to CRLF would insert, and
   * two places inserting the same carriage return would put in two. A lone
   * carriage return, which nothing makes any more, becomes a line feed.
   */
  private mend(api: typeof monaco, model: monaco.editor.ITextModel) {
    if (model.isDisposed()) return;
    const text = this.ytext.toString();
    if (text.includes("\r")) {
      this.ydoc.transact(() => {
        for (let i = text.length - 1; i >= 0; i--) {
          if (text.charCodeAt(i) !== 13) continue;
          this.ytext.delete(i, 1);
          if (text.charCodeAt(i + 1) !== 10) this.ytext.insert(i, "\n");
        }
      }, "local");
    }
    this.applyingRemote = true;
    try {
      model.setEOL(api.editor.EndOfLineSequence.LF);
      replaceText(api, model, this.ytext.toString());
    } finally {
      this.applyingRemote = false;
    }
  }

  /** Everyone else's cursor and selection, as editor decorations. */
  private drawCursors(model: monaco.editor.ITextModel) {
    const api = this.api;
    if (!this.views.size || !api) return;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const rules: string[] = [];

    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue;
      const user = (state as { user?: { id: unknown; name: unknown } }).user;
      const cursor = (state as { cursor?: { index: unknown; length: unknown } }).cursor;
      const id = participantId(user?.id);
      if (id === null || typeof cursor?.index !== "number" || typeof cursor.length !== "number") continue;
      if (!Number.isFinite(cursor.index) || !Number.isFinite(cursor.length)) continue;

      const colour = colourFor(id);
      const cls = `remote-${id}`;
      rules.push(
        `.${cls}-caret { border-left: 2px solid ${colour}; margin-left: -1px; }`,
        `.${cls}-selection { background: ${colour}33; }`,
        // A dot on the caret in the person's colour, and no name. The name was
        // "guest 3", which read as a count or a rank; the colour is matched to
        // a person by the dots beside the presence count instead.
        `.${cls}-label::after { content: ""; background: ${colour}; }`,
      );

      const total = model.getValueLength();
      const from = model.getPositionAt(Math.min(cursor.index, total));
      const to = model.getPositionAt(Math.min(cursor.index + cursor.length, total));

      if (cursor.length > 0) {
        decorations.push({
          range: api.Range.fromPositions(from, to),
          options: { className: `${cls}-selection remote-selection` },
        });
      }
      decorations.push({
        range: api.Range.fromPositions(to, to),
        options: {
          className: `${cls}-caret remote-caret`,
          beforeContentClassName: `${cls}-label remote-label`,
          stickiness: api.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }

    // One stylesheet per document, rewritten as people come and go — Monaco
    // decorations take class names, not colours.
    if (!this.styleEl) {
      this.styleEl = document.createElement("style");
      document.head.appendChild(this.styleEl);
    }
    this.styleEl.textContent = rules.join("\n");
    for (const view of this.views.values()) if (view.model === model) view.decorations.set(decorations);
  }

  destroy() {
    this.binding?.();
    removeAwarenessStates(this.awareness, [this.awareness.clientID], "local");
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}

/**
 * Make a model's text `text` by replacing only what differs — the stretch
 * between the longest common start and the longest common end — rather than
 * all of it. `setValue` throws away where the view and the cursor were and
 * opens at line 1; an edit keeps them, and moves them only as far as the text
 * before them changed.
 */
export function replaceText(api: typeof monaco, model: monaco.editor.ITextModel, text: string): void {
  const old = model.getValue();
  if (old === text) return;
  const limit = Math.min(old.length, text.length);
  let start = 0;
  while (start < limit && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  let end = 0;
  while (end < limit - start && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
  // Never split a surrogate pair, at either end.
  [start, end] = wholeCharacters(old, start, end);
  [start, end] = wholeCharacters(text, start, end);
  const range = api.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(old.length - end));
  model.applyEdits([{ range, text: text.slice(start, text.length - end) }]);
}
