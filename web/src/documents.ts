import type { EditorPane } from "./workspace";
import type { DocSession, Held } from "./editing";
import { Channel, DocKind, TARGET_ALL, jsonFrame, streamFrame, tagged, untag, parseJson, type Frame, type Doc, type Fs } from "./proto";

interface OpenFile {
  path: string;
  doc: DocSession | null;
  requested: boolean;
  ready: boolean;
  initializing: boolean;
  held: Held | null;
  holding: { dispose(): void } | null;
  failed: string | null;
  views: Map<string, () => void>;
  generation: number;
}
interface DocumentOptions {
  send: (frame: Frame) => void;
  online: () => boolean;
  away: () => boolean;
  readOnly: () => boolean;
  user: () => { id: number; name: string };
  unsent: (value: boolean) => void;
  copy: () => Map<string, string> | null;
}

/** Per-file document recovery and per-group views. The host protocol stays unchanged. */
export class SessionDocuments {
  private readonly files = new Map<string, OpenFile>();
  private readonly streams = new Map<number, OpenFile>();
  private readonly early = new Map<number, Array<[DocKind, Uint8Array]>>();
  private readonly pendingStreams = new Map<number, OpenFile>();
  private earlyBytes = 0;
  private earlyCount = 0;
  private disposed = false;
  private syncing = false;
  private readonly shownCopies = new Map<string, string | undefined>();
  constructor(private editor: EditorPane, private options: DocumentOptions) {}
  private file(path: string) {
    let file = this.files.get(path);
    if (!file) { file = { path, doc: null, requested: false, ready: false, initializing: false, held: null, holding: null, failed: null, views: new Map(), generation: 0 }; this.files.set(path, file); }
    return file;
  }
  private request(file: OpenFile) {
    if (file.requested || file.doc || file.failed || !this.options.online() || this.options.away()) return;
    file.requested = true;
    this.options.send(jsonFrame(Channel.Doc, TARGET_ALL, { t: "open", path: file.path } satisfies Doc));
  }
  sync() {
    if (this.disposed || this.syncing) return;
    this.syncing = true;
    try {
      const visible = this.editor.groups.visiblePaths;
      // Free every clean hidden subscription before sending any replacement
      // opens, so a pane switch also works at the host's document limit.
      for (const file of this.files.values()) {
        for (const [id, detach] of file.views) {
          if (this.editor.viewers.get(id)?.current !== file.path || !visible.has(file.path)) { detach(); file.views.delete(id); }
        }
        if (file.doc && file.ready && !visible.has(file.path) && !file.doc.waiting && !this.options.away()) this.release(file, true);
      }
      for (const path of visible) {
        if (![...this.editor.viewers.values()].some(viewer => viewer.current === path)) continue;
        const file = this.file(path);
        if (this.options.away()) { if (!file.doc && !file.held) this.showCopy(file); }
        else this.request(file);
      }
      for (const file of this.files.values()) {
        if (file.doc && file.ready) {
          for (const [id, viewer] of this.editor.viewers) if (viewer.current === file.path && viewer.handles && !file.views.has(id)) file.views.set(id, file.doc.attachView(viewer.handles.editor, viewer.handles.model));
        }
        if (!visible.has(file.path) && file.held && this.hasPendingEdits(file)) this.request(file);
        if (file.failed && file.held) this.recovery(file);
      }
      const active = this.editor.path ? this.files.get(this.editor.path) : null;
      const host = document.getElementById("viewer");
      if (host) { if (active?.ready) host.dataset.editing = active.path; else delete host.dataset.editing; }
      this.settle();
    } finally { this.syncing = false; }
  }
  /** A permanently refused file still offers a way to keep or discard its local typing. */
  private recovery(file: OpenFile) {
    // A closed tab may no longer have a tree entry after reconnection. Keep
    // its retained text reachable; other recovery tabs can stay in the strip.
    if (!this.editor.groups.paths.has(file.path)) this.editor.groups.open(file.path);
    for (const [id, viewer] of this.editor.viewers) {
      if (viewer.current !== file.path) continue;
      const note = this.editor.groups.views.get(id)?.title;
      if (!note || note.querySelector(".document-recovery")) continue;
      note.hidden = false;
      const actions = document.createElement("span"); actions.className = "document-recovery";
      const save = document.createElement("button"); save.type = "button"; save.textContent = "Save local copy";
      save.onclick = () => {
        const url = URL.createObjectURL(new Blob([this.editor.models.get(file.path)?.getValue() ?? file.held?.local ?? ""], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = file.path.split("/").pop()!; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
        file.held = null; file.holding?.dispose(); file.holding = null;
        this.editor.stranded(file.path, `${file.failed} — local copy downloaded`); this.settle();
      };
      const discard = document.createElement("button"); discard.type = "button"; discard.textContent = "Discard local changes";
      discard.onclick = () => {
        if (!confirm(`Discard the retained changes to ${file.path}?`)) return;
        file.held = null; file.holding?.dispose(); file.holding = null;
        for (const group of [...this.editor.groups.model.groups]) if (group.tabs.includes(file.path)) this.editor.groups.close(file.path, group.id);
        this.editor.forget(file.path); this.files.delete(file.path); this.settle();
      };
      actions.append(save, discard); note.append(actions);
    }
  }
  private hasPendingEdits(file: OpenFile) {
    return !!file.doc?.waiting || !!file.held?.sent.unconfirmed.length || (!!file.held && this.editor.models.get(file.path)?.getValue() !== file.held.local);
  }
  private settle() { this.options.unsent([...this.files.values()].some(file => this.hasPendingEdits(file))); }
  private showCopy(file: OpenFile) {
    const text = this.options.copy()?.get(file.path);
    if (this.shownCopies.has(file.path) && this.shownCopies.get(file.path) === text) return;
    this.shownCopies.set(file.path, text);
    if (text !== undefined) void this.editor.show(file.path, text, false, true, "saved copy, read-only while the host is away");
    else this.editor.problem(file.path, this.options.copy() ? "not in the saved copy — it opens when the host is back" : "the host is away — waiting for the saved copy");
  }
  copyChanged() { for (const path of this.editor.groups.visiblePaths) { const file = this.file(path); if (!file.doc && !file.held) this.showCopy(file); } }
  disconnected() { this.settle(); }
  welcome() {
    this.early.clear(); this.earlyBytes = this.earlyCount = 0; this.pendingStreams.clear(); this.shownCopies.clear();
    for (const file of this.files.values()) {
      if (file.doc && (file.ready || file.initializing)) file.held = { sent: file.doc.sent(), local: this.editor.models.get(file.path)?.getValue() ?? file.doc.ytext.toString() };
      this.release(file, false);
      file.requested = false; file.failed = null;
      if (file.held) this.hold(file);
    }
    this.sync();
  }
  hostBack() {
    this.shownCopies.clear();
    const visible = this.editor.groups.visiblePaths;
    for (const file of this.files.values()) {
      // Cached files and clean recovery snapshots need no host subscription.
      // Leave the host's document slots for panes in use and unsaved typing.
      if (!visible.has(file.path) && !this.hasPendingEdits(file)) continue;
      if (file.doc) this.options.send(streamFrame(Channel.Doc, file.doc.docId, tagged(DocKind.Update, file.doc.fullState())));
      else file.requested = false;
    }
    this.sync();
  }
  permissionsChanged() {
    for (const file of this.files.values()) {
      this.release(file, true); file.failed = null; file.requested = false;
      this.editor.setReadOnly(file.path, true);
    }
    this.sync();
  }
  forget(id: number) { for (const file of this.files.values()) file.doc?.forget(id); }
  private hold(file: OpenFile) {
    file.holding?.dispose();
    file.holding = this.editor.models.get(file.path)?.onDidChangeContent(() => this.settle()) ?? null;
  }
  private release(file: OpenFile, notify: boolean) {
    file.generation++;
    for (const [id, pending] of this.pendingStreams) if (pending === file) { this.pendingStreams.delete(id); this.takeEarly(id); }
    for (const detach of file.views.values()) detach(); file.views.clear();
    if (file.doc) {
      this.streams.delete(file.doc.docId);
      if (notify && !file.held) this.editor.setReadOnly(file.path, true);
      if (notify) this.options.send(jsonFrame(Channel.Doc, TARGET_ALL, { t: "close", doc_id: file.doc.docId } satisfies Doc));
      file.doc.destroy();
    }
    file.doc = null; file.ready = false; file.initializing = false; file.requested = false;
  }
  async frame(frame: Frame) {
    if (this.disposed) return;
    if (frame.streamId === 0) {
      const msg = parseJson<Doc>(frame);
      if (msg.t === "opened") { await this.opened(msg.path, msg.doc_id); return; }
      if (msg.t === "closed") {
        const file = this.streams.get(msg.doc_id);
        if (file) {
          if (file.doc?.waiting) { file.held = { sent: file.doc.sent(), local: this.editor.models.get(file.path)?.getValue() ?? file.doc.ytext.toString() }; this.hold(file); }
          this.release(file, false); file.failed = msg.reason;
          this.editor.stranded(file.path, msg.reason); this.sync();
        }
      } else if (msg.t === "error") {
        const file = this.file(msg.path); file.requested = false; file.failed = msg.message;
        if (file.held && !file.held.sent.unconfirmed.length && this.editor.models.get(file.path)?.getValue() === file.held.local) { file.held = null; file.holding?.dispose(); file.holding = null; }
        if (file.held) this.editor.stranded(msg.path, `${msg.message} — local typing retained`);
        else {
          this.editor.problem(msg.path, msg.message);
          this.options.send(jsonFrame(Channel.Fs, TARGET_ALL, { t: "read", path: msg.path } satisfies Fs));
        }
        this.sync();
      }
      return;
    }
    const packet = untag(frame.payload); if (!packet) return;
    const [kind, bytes] = packet, file = this.streams.get(frame.streamId);
    if (!file?.doc) {
      if (this.pendingStreams.has(frame.streamId) && this.early.size < 32 && this.earlyCount < 256 && this.earlyBytes + bytes.byteLength <= 32 * 1024 * 1024) {
        const queue = this.early.get(frame.streamId) ?? []; queue.push([kind, bytes]); this.early.set(frame.streamId, queue);
        this.earlyCount++; this.earlyBytes += bytes.byteLength;
      }
      return;
    }
    if (kind === DocKind.Update) { file.doc.applyUpdate(bytes); if (!file.ready) await this.initialize(file); else this.sync(); }
    else file.doc.applyAwareness(bytes);
  }
  private takeEarly(id: number) {
    const queue = this.early.get(id) ?? []; this.early.delete(id);
    this.earlyCount -= queue.length; this.earlyBytes -= queue.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
    return queue;
  }
  private async opened(path: string, id: number) {
    const file = this.file(path);
    if (file.doc?.docId === id) return;
    if (!file.requested && !this.editor.groups.visiblePaths.has(path) && !file.held) { this.options.send(jsonFrame(Channel.Doc, TARGET_ALL, { t: "close", doc_id: id } satisfies Doc)); return; }
    const generation = file.generation;
    this.pendingStreams.set(id, file);
    let module: typeof import("./editing");
    try { module = await import("./editing"); }
    catch { this.pendingStreams.delete(id); file.requested = false; file.failed = "Couldn't load editing — select the file to retry"; this.editor.problem(path, file.failed); return; }
    const { DocSession } = module;
    if (this.disposed || generation !== file.generation || file.doc) return;
    const doc = new DocSession(id, path, this.options.user(), (kind, bytes) => {
      if (this.disposed) return;
      this.options.send(streamFrame(Channel.Doc, id, tagged(kind === "update" ? DocKind.Update : DocKind.Awareness, bytes)));
      if (kind === "update") this.settle();
    });
    file.doc = doc; file.requested = false; this.streams.set(id, file); this.pendingStreams.delete(id);
    const queue = this.takeEarly(id);
    let state = false;
    for (const [kind, bytes] of queue) if (kind === DocKind.Update) { doc.applyUpdate(bytes); state = true; } else doc.applyAwareness(bytes);
    if (state) await this.initialize(file);
  }
  private async initialize(file: OpenFile) {
    const doc = file.doc; if (!doc || file.ready || file.initializing) return;
    // Mark before awaiting: additional frames must update this same document.
    file.initializing = true;
    const generation = file.generation;
    await this.editor.load();
    if (this.disposed || generation !== file.generation) return;
    if (file.held) {
      const local = this.editor.models.get(file.path)?.getValue() ?? file.held.local;
      doc.handBack({ sent: file.held.sent, local }); file.held = null;
    }
    file.holding?.dispose(); file.holding = null;
    const text = doc.ytext.toString();
    const model = await this.editor.show(file.path, text, false, this.options.readOnly());
    if (!model || this.disposed || generation !== file.generation) return;
    if (model.getValue() !== text) {
      this.release(file, true); file.failed = "mixed line endings or a byte-order mark"; this.editor.stranded(file.path, file.failed); return;
    }
    doc.onDrift = () => { if (file.doc === doc) { this.release(file, true); file.failed = "its line endings changed — reopen it to edit"; this.editor.stranded(file.path, file.failed); } };
    doc.bindModel(model);
    if (model.getValue() !== doc.ytext.toString()) { doc.onDrift(); return; }
    file.ready = true; file.initializing = false;
    this.sync();
  }
  content(path: string, text: string, truncated: boolean, binary: boolean) {
    const file = this.file(path); if (file.held || file.doc) return;
    if (binary) this.editor.problem(path, "binary file");
    else void this.editor.show(path, text, truncated, true, file.failed ? `read-only: ${file.failed}` : undefined);
  }
  retry(path: string) { const file = this.files.get(path); if (file?.failed) { file.failed = null; file.requested = false; } this.sync(); }
  dispose() {
    this.disposed = true;
    for (const file of this.files.values()) { file.holding?.dispose(); this.release(file, true); }
    this.files.clear(); this.early.clear();
  }
}
