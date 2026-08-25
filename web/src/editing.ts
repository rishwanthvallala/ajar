import * as monaco from "monaco-editor";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";

/**
 * Collaborative editing bound to Monaco.
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
  return COLOURS[id % COLOURS.length];
}

export interface RemoteCursor {
  index: number;
  length: number;
  name: string;
  id: number;
}

/** One open file, shared. */
export class DocSession {
  readonly ydoc = new Y.Doc();
  readonly ytext: Y.Text;
  readonly awareness: Awareness;
  private binding: (() => void) | null = null;
  private applyingRemote = false;
  private decorations: monaco.editor.IEditorDecorationsCollection | null = null;
  private styleEl: HTMLStyleElement | null = null;

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
      const changed = [...added, ...updated, ...removed];
      if (changed.length) {
        this.send("awareness", encodeAwarenessUpdate(this.awareness, changed));
      }
    });
  }

  applyUpdate(bytes: Uint8Array) {
    Y.applyUpdate(this.ydoc, bytes, "remote");
  }

  applyAwareness(bytes: Uint8Array) {
    applyAwarenessUpdate(this.awareness, bytes, "remote");
  }

  /** Attach to an editor. Returns a function that detaches everything. */
  bind(editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel) {
    // The document is the truth; the model starts from it.
    if (model.getValue() !== this.ytext.toString()) {
      model.setValue(this.ytext.toString());
    }
    this.decorations = editor.createDecorationsCollection([]);

    const onRemote = (event: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.local) return;
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
      }, "local");
    });

    const onCursor = editor.onDidChangeCursorSelection(() => {
      const sel = editor.getSelection();
      if (!sel) return;
      const start = model.getOffsetAt(sel.getStartPosition());
      const end = model.getOffsetAt(sel.getEndPosition());
      this.awareness.setLocalStateField("cursor", { index: start, length: end - start });
    });

    const onAwareness = () => this.drawCursors(model);
    this.awareness.on("change", onAwareness);
    this.drawCursors(model);

    this.binding = () => {
      this.ytext.unobserve(onRemote);
      onLocal.dispose();
      onCursor.dispose();
      this.awareness.off("change", onAwareness);
      this.decorations?.clear();
      this.styleEl?.remove();
      this.styleEl = null;
    };
    return this.binding;
  }

  /** Everyone else's cursor and selection, as editor decorations. */
  private drawCursors(model: monaco.editor.ITextModel) {
    if (!this.decorations) return;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const rules: string[] = [];

    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue;
      const user = (state as { user?: { id: number; name: string } }).user;
      const cursor = (state as { cursor?: { index: number; length: number } }).cursor;
      if (!user || !cursor) continue;

      const colour = colourFor(user.id);
      const cls = `remote-${user.id}`;
      rules.push(
        `.${cls}-caret { border-left: 2px solid ${colour}; margin-left: -1px; }`,
        `.${cls}-selection { background: ${colour}33; }`,
        `.${cls}-label::after { content: "${user.name.replace(/"/g, "")}"; background: ${colour}; }`,
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
    this.decorations.set(decorations);
  }

  destroy() {
    this.binding?.();
    removeAwarenessStates(this.awareness, [this.awareness.clientID], "local");
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}
