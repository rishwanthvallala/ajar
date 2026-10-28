// The core API only — same reason as viewer.ts: the language services
// and their workers cannot run here and are nine megabytes of dead
// weight in the deploy.
import * as monaco from "monaco-editor/editor/editor.api";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { colourFor } from "./colours";
import { onThemeChange } from "@ajar/workspace-ui";
import { replaceText } from "./replace";
import { carryOver } from "./carry";
import { eolOf } from "@ajar/workspace-ui/eol";

/**
 * Collaborative editing bound to Monaco.
 *
 * Written here rather than pulled from `y-monaco`, which has not been
 * published since 2024 and predates this Monaco by several major versions.
 * The binding is small enough that owning it costs less than tracking a stale
 * dependency, and cursor rendering is the part you always end up customising.
 */

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
function cssString(text: string): string {
  return text.replace(/[\\"\u0000-\u001f]/g, (ch) => {
    if (ch === "\\" || ch === '"') return "\\" + ch;
    return "\\" + ch.charCodeAt(0).toString(16) + " ";
  });
}

/**
 * What this page sent of a document, against what the host has said it has:
 * enough to tell, once the page is back after losing touch, which of its
 * typing never arrived.
 */
export interface Sent {
  /** Everything the host has sent of the document, as one update. */
  confirmed: Uint8Array;
  /** Our updates it has not sent back, oldest first, with how far each takes our clock. */
  unconfirmed: { update: Uint8Array; to: number }[];
  /** The Yjs client they were made as. */
  client: number;
}

/** Typing to hand back to a file opened again: what was sent of it, and the text the page has. */
export interface Held {
  sent: Sent;
  local: string;
}

/** One open file, shared. */
export class DocSession {
  readonly ydoc = new Y.Doc();
  readonly ytext: Y.Text;
  readonly awareness: Awareness;
  private binding: (() => void) | null = null;
  private applyingRemote = false;
  private readonly views = new Map<monaco.editor.IStandaloneCodeEditor, { model: monaco.editor.ITextModel; decorations: monaco.editor.IEditorDecorationsCollection; dispose: () => void }>();
  private boundModel: monaco.editor.ITextModel | null = null;
  private styleEl: HTMLStyleElement | null = null;
  /**
   * The document as far as the host has confirmed it. The host passes every
   * update on to everyone, its sender included, so one of ours that has come
   * back is one that arrived — and one that has not may have gone down with
   * a socket the page still thought was open.
   */
  private readonly confirmed = new Y.Doc();
  private unconfirmed: { update: Uint8Array; to: number }[] = [];

  /** Told when the editor can no longer hold this document as it is. */
  onDrift: (() => void) | null = null;

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
      this.unconfirmed.push({ update, to: Y.getState(this.ydoc.store, this.ydoc.clientID) });
      this.send("update", update);
    });

    this.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin === "remote") return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length) {
        this.send("awareness", encodeAwarenessUpdate(this.awareness, changed));
      }
    });
  }

  applyUpdate(bytes: Uint8Array) {
    Y.applyUpdate(this.ydoc, bytes, "remote");
    Y.applyUpdate(this.confirmed, bytes);
    const arrived = Y.getState(this.confirmed.store, this.ydoc.clientID);
    while (this.unconfirmed.length && this.unconfirmed[0]!.to <= arrived) this.unconfirmed.shift();
  }

  /** Whether any of our updates has yet to come back from the host. */
  get waiting(): boolean {
    return this.unconfirmed.length > 0;
  }

  /** What was sent of this document, and how much of it the host has confirmed. */
  sent(): Sent {
    return {
      confirmed: Y.encodeStateAsUpdate(this.confirmed),
      unconfirmed: [...this.unconfirmed],
      client: this.ydoc.clientID,
    };
  }

  /**
   * Put typing held from before a lost connection into this document, the
   * host's copy of its file opened again: the change from what the host was
   * left with to what the page has, where the text around it still is.
   *
   * Measured from what the host was left with, not from what the page had
   * when it noticed the connection had gone: keystrokes handed to a socket
   * already dead were in that, and so were never sent again.
   */
  handBack(held: Held) {
    const edit = carryOver(reachedHost(held.sent, this.ydoc), held.local, this.ytext.toString());
    if (!edit) return;
    this.ydoc.transact(() => {
      if (edit.remove) this.ytext.delete(edit.at, edit.remove);
      if (edit.insert) this.ytext.insert(edit.at, edit.insert);
    }, "local");
  }

  /**
   * Everything this document holds, as one update.
   *
   * For handing back after the host has been away: whatever was typed in the
   * gap went to a host that was not there, and every later update depends on
   * it, so the host parks those as pending and the text never reaches the
   * file. Applying a whole state is idempotent, so resending it all costs the
   * host nothing it already had.
   */
  fullState(): Uint8Array<ArrayBuffer> {
    return Y.encodeStateAsUpdate(this.ydoc) as Uint8Array<ArrayBuffer>;
  }

  applyAwareness(bytes: Uint8Array) {
    applyAwarenessUpdate(this.awareness, bytes, "remote");
  }

  /**
   * Somebody left: their cursor goes with them.
   *
   * A browser that closes says nothing on its way out, so its awareness state
   * would sit here until it timed out — a cursor, with a name on it, for
   * someone no longer in the room. The relay's `left` is the word that they
   * have gone.
   */
  forget(participant: number) {
    const gone: number[] = [];
    for (const [client, state] of this.awareness.getStates()) {
      if (client === this.awareness.clientID) continue;
      if (participantId((state as { user?: { id?: unknown } }).user?.id) === participant) gone.push(client);
    }
    if (gone.length) removeAwarenessStates(this.awareness, gone, "remote");
  }

  /** Compatibility wrapper for single-view callers. */
  bind(editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel) {
    const unbind = this.bindModel(model);
    const detach = this.attachView(editor, model);
    return () => { detach(); unbind(); };
  }

  /** Exactly one text binding, regardless of the number of editor views. */
  bindModel(model: monaco.editor.ITextModel) {
    if (this.boundModel === model && this.binding) return this.binding;
    this.binding?.();
    this.boundModel = model;
    // The document is the truth; the model starts from it — brought there by
    // an edit rather than `setValue`, which would send the view to line 1 —
    // and in its line ending. A file with no line breaks yet took Monaco's
    // default, which is the operating system's: CRLF for a guest on Windows,
    // LF on a Mac. The first Enter on Windows put a CRLF in the document that
    // the Mac's model held as LF, and every edit after it landed a character
    // off — in the document, and on the host's disk.
    const eol = eolOf(this.ytext.toString()) ?? "\n";
    if (model.getEOL() !== eol) {
      model.setEOL(eol === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    }
    replaceText(model, this.ytext.toString());

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
              { range: monaco.Range.fromPositions(at, at), text, forceMoveMarkers: true },
            ]);
            index += text.length;
          } else if (op.delete != null) {
            const from = model.getPositionAt(index);
            const to = model.getPositionAt(index + op.delete);
            model.applyEdits([{ range: monaco.Range.fromPositions(from, to), text: "" }]);
          }
        }
      } finally {
        this.applyingRemote = false;
      }
      // A line ending the model converted on the way in — written on the host
      // by something else. From here every offset would be off, so this
      // stops being edited rather than drift.
      if (model.getValueLength() !== this.ytext.length) this.onDrift?.();
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

    const themed = new AbortController();
    onThemeChange(() => this.drawCursors(model), themed.signal);
    const binding = () => {
      if (this.binding !== binding) return;
      this.binding = null;
      this.boundModel = null;
      themed.abort();
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

  /** Everyone else's cursor and selection, as editor decorations. */
  private drawCursors(model: monaco.editor.ITextModel) {
    if (!this.views.size) return;
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
        `.${cls}-label::after { content: "${cssString(typeof user?.name === "string" ? user.name : "")}"; background: ${colour}; }`,
      );

      const total = model.getValueLength();
      const from = model.getPositionAt(Math.min(cursor.index, total));
      const to = model.getPositionAt(Math.min(cursor.index + cursor.length, total));

      if (cursor.length > 0) {
        decorations.push({
          range: monaco.Range.fromPositions(from, to),
          options: { className: `${cls}-selection remote-selection` },
        });
      }
      decorations.push({
        range: monaco.Range.fromPositions(to, to),
        options: {
          className: `${cls}-caret remote-caret`,
          beforeContentClassName: `${cls}-label remote-label`,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
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
    this.confirmed.destroy();
  }
}

/**
 * The text the host was left with of a document this page lost touch with,
 * given the host's document for its file now.
 *
 * At least what it confirmed, and of the rest as much as it shows it has. A
 * document still open on the host — someone else had it open too — holds our
 * updates under their ids, so its clock for us says how far they got. One it
 * opened again from the file has ids of its own, and only its text to go by:
 * the last of our updates that leaves the text as the host has it is the last
 * that arrived. Typing that reached the host with only its echo lost is not
 * put in twice that way.
 */
function reachedHost(sent: Sent, now: Y.Doc): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, sent.confirmed);
    const text = doc.getText("content");
    const got = Y.getState(now.store, sent.client);
    if (got > 0) {
      for (const { update, to } of sent.unconfirmed) if (to <= got) Y.applyUpdate(doc, update);
      return text.toString();
    }
    const there = now.getText("content").toString();
    let reached = text.toString();
    for (const { update } of sent.unconfirmed) {
      Y.applyUpdate(doc, update);
      if (text.length === there.length && text.toString() === there) reached = there;
    }
    return reached;
  } finally {
    doc.destroy();
  }
}
