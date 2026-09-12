import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Workspace, type LayoutStorage } from "./workspace";
import { FileTree } from "./tree";
import { codeFontPx } from "./scale";
import type { Entry } from "./proto";

const files: Record<string, string> = {
  "src/main.ts": `import { greet } from "./greet";\n\n// A small project, ready to explore.\nconst team = ["Alex", "Sam", "You"];\n\nfor (const name of team) {\n  console.log(greet(name));\n}\n`,
  "src/greet.ts": `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
  "src/workspace-layout-accessibility-and-responsive-navigation.ts": `// Long filenames should stay readable without pushing controls away.\nexport const panels = ["files", "editor", "terminal"];\n`,
  "README.md": `# Welcome to the workspace\n\nSelect a file from the sidebar.\nDrag the dividers to make yourself comfortable.\n\nThis is sample content. Edits stay in this preview until you change scenarios.\nThe terminal output is simulated; no commands are executed.\n`,
  "package.json": `{\n  "name": "hello-workspace",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n`,
};

/** Development fixture only. It never imports or constructs Connection. */
export function renderPreview(app: HTMLElement): () => void {
  const preferences = new Map<string, string>();
  const storage: LayoutStorage = { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => { preferences.set(key, value); } };
  let unmount = () => {};
  let scenario = "populated";

  function mount() {
    unmount();
    const workspace = new Workspace(app, "hello-workspace", storage);
    const bar = workspace.el("preview-bar");
    bar.hidden = false;
    bar.innerHTML = `<strong>Development preview</strong><label>Example <select id="preview-scenario"><option value="populated">Populated</option><option value="empty">Empty</option><option value="disconnected">Disconnected</option></select></label><span>Sample files · Simulated terminals</span>`;
    const select = workspace.el<HTMLSelectElement>("preview-scenario");
    select.value = scenario;
    select.onchange = () => { scenario = select.value; mount(); };
    const disconnected = scenario === "disconnected";
    workspace.el("status").textContent = disconnected ? "Host disconnected" : "Connected";
    workspace.el("dot").className = `dot ${disconnected ? "closed" : "open"}`;
    workspace.el("people").innerHTML = `<span class="person host">Alex · host</span><span class="person">Sam</span><span class="person me">You</span>`;
    if (disconnected) {
      workspace.el("away").hidden = false;
      workspace.el("away").textContent = "The host is away. These sample files show a read-only saved copy. Terminals are unavailable until the host returns.";
      workspace.el("readonly").hidden = false;
    }

    let disposed = false;
    const contents = { ...files };
    let unbind: { dispose(): void } | null = null;
    let request = 0;
    async function open(path: string) {
      const version = ++request;
      unbind?.dispose(); unbind = null;
      const focus = workspace.fileSelected();
      tree.setActive(path);
      const viewer = await workspace.editor.open(path);
      if (!viewer || disposed || version !== request) return;
      viewer.show(path, contents[path] ?? "", false, disconnected);
      unbind = viewer.handles?.model.onDidChangeContent(() => { contents[path] = viewer.handles?.model.getValue() ?? ""; }) ?? null;
      if (focus) workspace.editor.focus();
    }
    const tree = new FileTree(workspace.el("tree"), path => { void open(path); });
    const entries: Entry[] = scenario === "empty" ? [] : [
      { path: "src", kind: "dir", size: 0 },
      ...Object.entries(files).map(([path, text]) => ({ path, kind: "file" as const, size: text.length })),
    ];
    tree.setEntries(entries);
    workspace.el("filecount").textContent = `${entries.filter(e => e.kind === "file").length} files`;
    workspace.el("close-file").onclick = () => {
      ++request; unbind?.dispose(); unbind = null;
      workspace.editor.close(); tree.setActive(null); workspace.editor.focus();
    };

    const terminals: { term: Terminal; fit: FitAddon; el: HTMLElement; button: HTMLButtonElement }[] = [];
    let active = 0;
    let split = false;
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const terminalTheme = () => dark.matches ? { background: "#161a22", foreground: "#e7eaf0" } : { background: "#ffffff", foreground: "#13171e" };
    let frame = 0;
    function layout() {
      if (disposed) return;
      terminals.forEach((t, i) => {
        t.el.classList.toggle("shown", i === active || (split && i === (active + 1) % terminals.length));
        t.button.classList.toggle("active", i === active);
        t.button.setAttribute("aria-pressed", String(i === active));
        t.term.options.fontSize = codeFontPx();
      });
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        terminals.filter(t => t.el.classList.contains("shown")).forEach(t => t.fit.fit());
        workspace.editor.viewer?.layout();
      });
    }
    function addTerminal() {
      workspace.el("empty").hidden = true;
      const el = document.createElement("div"); el.className = "term";
      const button = document.createElement("button"); button.className = "tab";
      const index = terminals.length;
      button.textContent = `terminal ${index + 1}`;
      button.onclick = () => { active = index; layout(); };
      workspace.el("tabs").appendChild(button); workspace.el("terms").appendChild(el);
      const term = new Terminal({ fontSize: codeFontPx(), fontFamily: "Consolas, monospace", theme: terminalTheme(), disableStdin: true, cursorBlink: false, convertEol: true });
      const fit = new FitAddon(); term.loadAddon(fit); term.open(el);
      term.write("\x1b[90mSimulated terminal · commands are not executed\x1b[0m\r\n\r\n");
      term.write(index === 0 ? "\x1b[36m~/hello-workspace\x1b[0m $ npm run dev\r\n\r\n  \x1b[32mVITE\x1b[0m ready\r\n  Local: http://localhost:5173/\r\n\r\n  Watching for file changes...\r\n" : "\x1b[36m~/hello-workspace\x1b[0m $ node src/main.ts\r\nHello, Alex!\r\nHello, Sam!\r\nHello, You!\r\n");
      terminals.push({ term, fit, el, button }); active = index; layout();
    }
    const newButton = workspace.el<HTMLButtonElement>("new-terminal");
    newButton.disabled = disconnected;
    newButton.onclick = addTerminal;
    workspace.el("split").onclick = () => {
      split = !split;
      if (split && terminals.length < 2) addTerminal();
      workspace.el("terms").classList.toggle("split", split);
      workspace.el("split").setAttribute("aria-pressed", String(split));
      layout();
    };
    workspace.el<HTMLButtonElement>("split").disabled = disconnected;
    if (scenario !== "empty") { addTerminal(); void open("src/main.ts"); }
    workspace.onLayout = layout;
    const themeChanged = () => terminals.forEach(t => { t.term.options.theme = terminalTheme(); });
    dark.addEventListener("change", themeChanged);
    unmount = () => {
      disposed = true; ++request; cancelAnimationFrame(frame);
      unbind?.dispose(); tree.dispose(); workspace.dispose(); terminals.forEach(t => t.term.dispose());
      dark.removeEventListener("change", themeChanged);
    };
  }
  mount();
  const dispose = () => { unmount(); window.removeEventListener("pagehide", dispose); };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
