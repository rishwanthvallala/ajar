import { PadWorkspace } from "./workspace";

type Scenario = "populated" | "empty" | "saving" | "save-failure" | "runtime-loading" | "running" | "disconnected";

const scenarios: Array<{ value: Scenario; label: string }> = [
  { value: "populated", label: "Populated" },
  { value: "empty", label: "Empty" },
  { value: "saving", label: "Saving" },
  { value: "save-failure", label: "Save failure" },
  { value: "runtime-loading", label: "Runtime loading" },
  { value: "running", label: "Running" },
  { value: "disconnected", label: "Disconnected" },
];

const files = new Map([
  ["main.py", `from pathlib import Path\n\nmessage = "hello from pad"\nprint(message)\nPath("out.txt").write_text(message)\n`],
  ["README.md", "# Gentle grotto\n\nA small shared folder for experiments.\n"],
]);

export function startWorkspacePreview(): void {
  const preferences = new Map<string, string>();
  const storage = {
    getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => { preferences.set(key, value); },
  };
  const ui = new PadWorkspace(document.getElementById("app")!, "gentle-grotto-3842", storage);
  const signal = new AbortController();
  const bar = ui.shell.el("preview-bar");
  const label = document.createElement("label");
  label.textContent = "Pad workspace preview ";
  const select = document.createElement("select");
  select.id = "preview-scenario";
  for (const scenario of scenarios) select.add(new Option(scenario.label, scenario.value));
  label.append(select);
  const note = document.createElement("span");
  note.textContent = "Local fixture · no relay or runtime";
  bar.replaceChildren(label, note);
  bar.hidden = false;

  const output = document.createElement("pre");
  output.className = "fixture-terminal";
  ui.elements.terminal.replaceChildren(output);
  let active = "main.py";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const showFile = (path: string) => {
    active = path;
    ui.elements.editor.dataset.active = path;
    ui.setActiveFile(path);
    ui.elements.editor.replaceChildren(Object.assign(document.createElement("pre"), {
      className: "fixture-code",
      textContent: files.get(path) ?? "",
    }));
    for (const row of ui.elements.files.querySelectorAll<HTMLElement>(".row.file")) row.classList.toggle("on", row.dataset.path === path);
    if (ui.fileSelected()) ui.elements.editor.focus();
  };

  const renderTree = (empty: boolean) => {
    const actions = document.createElement("div");
    actions.className = "tree-bar";
    for (const text of ["New file", "New folder"]) {
      const control = document.createElement("button");
      control.className = "icon fixture-icon";
      control.setAttribute("aria-label", text);
      control.title = text;
      control.textContent = text === "New file" ? "+F" : "+D";
      actions.append(control);
    }
    const tree = document.createElement("div");
    tree.className = "tree";
    if (!empty) {
      for (const path of files.keys()) {
        const row = document.createElement("button");
        row.className = `row file${path === active ? " on" : ""}`;
        row.dataset.path = path;
        row.textContent = path;
        row.addEventListener("click", () => showFile(path), { signal: signal.signal });
        tree.append(row);
      }
    }
    ui.elements.files.replaceChildren(actions, tree);
    ui.setFileCount(empty ? 0 : files.size);
  };

  const status = (kind: string, text: string) => {
    ui.elements.status.dataset.status = kind;
    ui.elements.status.textContent = text;
  };

  const render = (scenario: Scenario) => {
    if (timer) clearTimeout(timer);
    timer = null;
    ui.elements.previewPane.hidden = true;
    ui.elements.editor.hidden = false;
    ui.elements.preview.hidden = scenario !== "running";
    ui.setPreview(false);
    const empty = scenario === "empty";
    renderTree(empty);
    ui.shell.el("editor-empty").hidden = !empty;
    ui.shell.el("viewer").hidden = empty;
    if (empty) {
      ui.shell.el("viewer-title").textContent = "No file selected";
      output.textContent = "No commands yet.\n";
    } else {
      showFile(active);
      output.textContent = "$ python main.py\nhello from pad\n$ ";
    }
    ui.elements.presence.textContent = scenario === "disconnected" ? "offline" : "2 here";
    if (scenario === "saving") status("saving", "saving…");
    else if (scenario === "save-failure") status("error", "save failed — retrying…");
    else if (scenario === "runtime-loading") status("loading", "fetching python, first time only…");
    else if (scenario === "running") status("running", "running…");
    else if (scenario === "disconnected") status("error", "disconnected — reconnecting…");
    else status("", empty ? "new folder — nothing saved yet" : "saved");
    ui.shell.requestLayout();
  };

  select.addEventListener("change", () => render(select.value as Scenario), { signal: signal.signal });
  ui.elements.run.addEventListener("click", () => {
    status("running", "running…");
    output.textContent += "\n$ python main.py\nhello from pad\n";
    timer = setTimeout(() => status("", "done"), 700);
  }, { signal: signal.signal });
  ui.elements.share.addEventListener("click", () => status("", "link copied (simulated)"), { signal: signal.signal });
  const closePreview = () => {
    ui.elements.previewPane.hidden = true;
    ui.elements.editor.hidden = false;
    ui.setPreview(false);
  };
  ui.elements.preview.addEventListener("click", () => {
    if (!ui.elements.previewPane.hidden) return closePreview();
    const frame = document.createElement("iframe");
    frame.title = "Simulated server preview";
    frame.setAttribute("sandbox", "");
    frame.srcdoc = "<!doctype html><title>Preview</title><style>body{font:16px system-ui;padding:2rem}</style><h1>Server is running</h1><p>Fixture preview on port 3000.</p>";
    ui.elements.previewPane.replaceChildren(frame);
    ui.elements.previewPane.hidden = false;
    ui.elements.editor.hidden = true;
    ui.setPreview(true);
  }, { signal: signal.signal });
  ui.elements.backToEditor.addEventListener("click", closePreview, { signal: signal.signal });
  addEventListener("pagehide", () => {
    if (timer) clearTimeout(timer);
    signal.abort();
    ui.dispose();
  }, { once: true });
  (window as unknown as { __padPreview: unknown }).__padPreview = { preferences, ui };
  render("populated");
}
