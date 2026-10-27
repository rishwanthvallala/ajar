import type { PadWorkspace } from "./workspace";
import { button, el, modal } from "./ui";
import { isApple, searchShortcut, shortcutLabel } from "./search-keys";
import { replaced, type ReplacementFile, type ReplacementPlan, type SearchFile, type SearchGroup, type SearchMatch, type SearchOptions, type SearchRequest, type SearchResults } from "./search-match";

export interface SearchHooks {
  files(): Array<{ path: string; text?: string }>;
  folders(): string[];
  canReplace(): boolean;
  open(path: string, match?: SearchMatch, before?: string): void;
  prepare(files: ReplacementFile[], replacement: string): Promise<ReplacementPlan>;
  apply(plan: ReplacementPlan): Promise<string>;
}

/** The pad's sidebar search. Its worker owns the index; App owns text and edits. */
export class ProjectSearch {
  private readonly events = new AbortController();
  private readonly query = el("input", { type: "search", placeholder: "Search…" });
  private readonly mode = el("select");
  private readonly folder = el("select");
  private readonly matchCase = el("input", { type: "checkbox" });
  private readonly wholeWord = el("input", { type: "checkbox" });
  private readonly matching = el("div", { className: "search-options" });
  private readonly status = el("p", { className: "search-status" });
  private readonly results = el("div", { className: "search-results" });
  private readonly replacement = el("input", { type: "text", placeholder: "Replace with…" });
  private readonly replaceDetails = el("details", { className: "search-replace" });
  private readonly preview = button("Preview replacements", { onClick: () => void this.prepare() });
  private worker: Worker | null = null;
  private indexed = new Map<string, SearchFile>();
  private revision = 0;
  private generation = 0;
  private result: SearchResults | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private preparing = false;
  private applying = false;
  private previousFocus: HTMLElement | null = null;
  private dialog: HTMLDialogElement | null = null;
  private readonly apple = isApple(navigator.platform || navigator.userAgent);

  constructor(private readonly ui: PadWorkspace, private readonly hooks: SearchHooks) {
    const label = (name: string, control: HTMLElement) => {
      control.setAttribute("aria-label", name);
      return el("label", {}, el("span", {}, name), control);
    };
    this.mode.append(new Option("File contents", "contents"), new Option("File names", "names"));
    this.folder.append(new Option("Entire pad", ""));
    this.query.setAttribute("aria-label", "Search query");
    this.query.setAttribute("autocomplete", "off");
    this.replacement.setAttribute("aria-label", "Replacement text");
    this.status.setAttribute("role", "status");
    this.results.setAttribute("aria-label", "Search results");
    this.results.setAttribute("aria-busy", "false");
    this.matching.append(label("Match case", this.matchCase), label("Whole word", this.wholeWord));
    const summary = el("summary", {}, "Replace");
    this.replaceDetails.append(summary, this.replacement, this.preview);
    const back = button("Back to files", { onClick: () => this.close() });
    ui.searchHost.append(back, label("Search", this.mode), this.query, label("In folder", this.folder), this.matching, this.replaceDetails, this.status, this.results);
    for (const b of ui.searchButtons) {
      b.title = `Search files and contents (${shortcutLabel("contents", this.apple)})`;
      b.setAttribute("aria-keyshortcuts", this.apple ? "Meta+Shift+F" : "Control+Shift+F");
    }
    ui.onSearch = () => this.open("contents");
    const signal = this.events.signal;
    for (const input of [this.query, this.mode, this.folder, this.matchCase, this.wholeWord]) {
      // A query's change event fires on blur, during a result's mousedown.
      // Redrawing then removes the button before its click can arrive.
      input.addEventListener(input === this.query ? "input" : "change", () => this.invalidate(), { signal });
    }
    // Capture before editor/terminal handlers, and only consume our exact shortcuts.
    window.addEventListener("keydown", (event) => {
      if (document.querySelector("dialog[open]")) return;
      const mode = searchShortcut(event, this.apple);
      if (mode) {
        event.preventDefault(); event.stopImmediatePropagation();
        this.open(mode);
      } else if (event.key === "Escape" && this.opened && !this.ui.shell.shell.classList.contains("drawer-open") && this.ui.searchHost.contains(event.target as Node)) {
        event.preventDefault(); event.stopImmediatePropagation(); this.close();
      }
    }, { capture: true, signal });
    ui.searchHost.addEventListener("keydown", (event) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
      if (event.target !== this.query && !(event.target as HTMLElement).classList.contains("search-hit")) return;
      const hits = [...this.results.querySelectorAll<HTMLButtonElement>(".search-hit")];
      if (!hits.length) return;
      event.preventDefault();
      const at = hits.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Enter") (hits[at] ?? hits[0])!.click();
      else hits[event.key === "ArrowDown" ? (at + 1) % hits.length : (at < 0 ? hits.length - 1 : (at - 1 + hits.length) % hits.length)]!.focus();
    }, { signal });
  }

  open(mode: "names" | "contents"): void {
    if (!this.opened) this.previousFocus = document.activeElement as HTMLElement | null;
    this.opened = true;
    this.mode.value = mode;
    this.ui.showSearch(true);
    this.query.focus(); this.query.select();
    this.invalidate();
  }

  private close(): void {
    this.opened = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.ui.showSearch(false);
    if (this.previousFocus?.isConnected && this.previousFocus.getClientRects().length) this.previousFocus.focus();
    else this.ui.shell.el("side-toggle").focus();
  }

  invalidate(): void {
    if (!this.opened) return;
    this.generation++;
    this.result = null;
    this.paintControls();
    if (this.timer) clearTimeout(this.timer);
    this.results.replaceChildren();
    this.status.textContent = this.query.value ? "Searching…" : "Type to search this pad.";
    this.results.setAttribute("aria-busy", String(!!this.query.value));
    this.timer = setTimeout(() => this.run(), 150);
  }

  private options(): SearchOptions {
    return { query: this.query.value, mode: this.mode.value as SearchOptions["mode"], folder: this.folder.value,
      matchCase: this.matchCase.checked, wholeWord: this.wholeWord.checked };
  }

  private paintControls(): void {
    const content = this.mode.value === "contents";
    this.matching.hidden = !content;
    this.replaceDetails.hidden = !content || !this.hooks.canReplace();
    this.preview.disabled = this.preparing || this.applying || !this.result || this.result.truncated || !this.result.groups.length || !this.hooks.canReplace();
  }

  private run(): void {
    this.timer = null;
    if (!this.opened) return;
    const selected = this.folder.value;
    const folders = this.hooks.folders();
    this.folder.replaceChildren(new Option("Entire pad", ""), ...folders.map((p) => new Option(p, p)));
    if (selected && !folders.includes(selected)) this.folder.append(new Option(`${selected} (unavailable)`, selected));
    this.folder.value = selected;
    if (selected && !folders.includes(selected)) {
      this.status.textContent = "This folder is no longer available. Choose another folder.";
      this.results.setAttribute("aria-busy", "false"); return;
    }
    if (!this.query.value || /[\r\n]/.test(this.query.value)) {
      this.status.textContent = this.query.value ? "Search for text on a single line." : "Type to search this pad.";
      this.results.setAttribute("aria-busy", "false"); return;
    }
    try {
      if (!this.worker) {
        this.worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (event: MessageEvent<SearchResults>) => {
          if (!this.opened || event.data.generation !== this.generation) return;
          this.result = event.data;
          this.render();
        };
        this.worker.onerror = () => this.workerFailed();
        this.worker.onmessageerror = () => this.workerFailed();
      }
      const updates: SearchFile[] = [];
      const next = new Map<string, SearchFile>();
      for (const file of this.hooks.files()) {
        const old = this.indexed.get(file.path);
        const same = old && old.text === file.text;
        const entry = same ? old : { ...file, revision: ++this.revision };
        next.set(file.path, entry);
        if (!same) updates.push(entry);
      }
      const removed = [...this.indexed.keys()].filter((p) => !next.has(p));
      this.indexed = next;
      const request: SearchRequest = { generation: this.generation, updates, removed, options: this.options() };
      this.worker.postMessage(request);
    } catch { this.workerFailed(); }
  }

  private workerFailed(): void {
    this.worker?.terminate(); this.worker = null; this.indexed.clear(); this.result = null;
    this.status.textContent = "Search could not start. Change the query to try again.";
    this.results.setAttribute("aria-busy", "false"); this.paintControls();
  }

  private render(): void {
    const result = this.result!;
    const names = this.mode.value === "names";
    const count = result.groups.reduce((n, g) => n + g.matches.length, 0);
    const fileCount = `${result.groups.length} ${result.groups.length === 1 ? "file" : "files"}`;
    this.status.textContent = count ? `${count}${result.truncated ? "+" : ""} ${names ? `${count === 1 ? "file" : "files"}.` : `${count === 1 ? "match" : "matches"} in ${fileCount}.`}${result.truncated ? " Results limited to 5,000. Narrow your search to replace." : ""}` : "No results.";
    this.results.setAttribute("aria-busy", "false");
    this.results.replaceChildren();
    for (const group of result.groups) {
      const section = el("section", { className: "search-group" });
      if (!names) {
        const head = el("div", { className: "search-file-head" }, el("strong", {}, `${group.path} (${group.matches.length})`));
        if (this.hooks.canReplace()) {
          const preview = button("Replace…", { onClick: () => void this.prepare(group.path) });
          preview.disabled = result.truncated || this.preparing;
          head.append(preview);
        }
        section.append(head);
      }
      for (const match of group.matches) {
        const b = el("button", { type: "button", className: "search-hit" });
        b.title = names ? group.path : `${group.path}:${match.line}:${match.column}`;
        b.setAttribute("aria-label", names ? group.path : `${group.path}, line ${match.line}, column ${match.column}: ${match.before}${match.hit}${match.after}`);
        if (!names) b.append(el("span", { className: "search-line" }, String(match.line)));
        const snippet = el("span", { className: "search-snippet" }, match.before, el("mark", {}, match.hit), match.after);
        b.append(snippet);
        b.onclick = () => {
          this.hooks.open(group.path, names ? undefined : match, this.indexed.get(group.path)?.text);
        };
        section.append(b);
      }
      this.results.append(section);
    }
    this.paintControls();
  }

  private async prepare(path?: string): Promise<void> {
    if (this.preparing || this.applying || this.dialog || !this.hooks.canReplace() || !this.result || this.result.truncated) return;
    const groups: SearchGroup[] = this.result.groups.filter((g) => !path || g.path === path);
    const files = groups.flatMap((g) => {
      const file = this.indexed.get(g.path);
      return file?.text !== undefined && file.revision === g.revision ? [{ path: g.path, before: file.text, matches: g.matches }] : [];
    });
    if (!files.length) return;
    this.preparing = true; this.paintControls();
    try {
      const plan = await this.hooks.prepare(files, this.replacement.value);
      if (this.events.signal.aborted) return;
      const { dialog, body } = modal("Preview replacements", "Changes apply to everyone on this pad.", "search-preview");
      this.dialog = dialog;
      const count = plan.files.reduce((n, f) => n + f.matches.length, 0);
      body.append(el("p", {}, `${count} ${count === 1 ? "replacement" : "replacements"} in ${plan.files.length} ${plan.files.length === 1 ? "file" : "files"}. No project-wide undo. Long lines are shown as excerpts.`));
      if (plan.skipped.length) body.append(el("p", {}, `Skipped: ${plan.skipped.join("; ")}`));
      for (const file of plan.files) {
        const section = el("section", {}, el("h3", {}, file.path));
        const oldLines = file.before.split("\n");
        const newLines = replaced(file.before, file.matches, plan.replacement).split("\n");
        for (const line of new Set(file.matches.map((m) => m.line))) {
          const start = Math.max(0, file.matches.find((m) => m.line === line)!.column - 81);
          const excerpt = (text: string) => `${start ? "…" : ""}${text.slice(start, start + 600)}${text.length > start + 600 ? "…" : ""}`;
          section.append(el("pre", { className: "search-diff-before" }, `${line} − ${excerpt(oldLines[line - 1] ?? "")}`),
            el("pre", { className: "search-diff-after" }, `${line} + ${excerpt(newLines[line - 1] ?? "")}`));
        }
        body.append(section);
      }
      const message = el("p"); message.setAttribute("role", "status");
      const apply = button("Apply replacements", { onClick: async () => {
        if (apply.disabled) return;
        apply.disabled = true;
        message.textContent = "Applying replacements…";
        this.applying = true; this.paintControls();
        // Keep this modal open until completion; Escape must not permit another application.
        const preventCancel = (event: Event) => event.preventDefault();
        dialog.addEventListener("cancel", preventCancel);
        cancel.disabled = true;
        const closeButton = dialog.querySelector<HTMLButtonElement>(".modal-close");
        if (closeButton) closeButton.disabled = true;
        const blockBackdrop = (event: Event) => { if (event.target === dialog) event.stopImmediatePropagation(); };
        dialog.addEventListener("click", blockBackdrop, true);
        try {
          message.textContent = await this.hooks.apply(plan);
          cancel.textContent = "Done";
        } catch (e) { message.textContent = `Replacement stopped: ${(e as Error).message}`; }
        finally {
          this.applying = false; cancel.disabled = false;
          if (closeButton) closeButton.disabled = false;
          dialog.removeEventListener("cancel", preventCancel);
          dialog.removeEventListener("click", blockBackdrop, true);
          this.invalidate();
        }
      } });
      apply.disabled = !plan.files.length || !this.hooks.canReplace();
      const cancel = button("Cancel", { onClick: () => dialog.close() });
      body.append(message, el("div", { className: "search-preview-actions" }, cancel, apply));
      dialog.addEventListener("close", () => {
        this.dialog = null; this.query.focus();
      }, { once: true });
      dialog.showModal();
    } catch (e) { this.status.textContent = `Preview failed: ${(e as Error).message}`; }
    finally { this.preparing = false; this.paintControls(); }
  }

  dispose(): void {
    this.events.abort();
    if (this.timer) clearTimeout(this.timer);
    this.dialog?.close(); this.worker?.terminate(); this.indexed.clear();
    this.ui.onSearch = () => {};
  }
}
