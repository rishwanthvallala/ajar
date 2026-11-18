/**
 * Format Document, for every kind of file there is a formatter for that runs
 * in a page.
 *
 * Monaco's own formatters live in the language workers, which cannot start
 * here (App.openEditor), so the editor had none. These are the formatters
 * people already use, compiled to WebAssembly by the wasm-fmt project: Ruff
 * for Python, clang-format for C, C++ and Java, gofmt, Biome and its kin for
 * the web's languages, and others. Each is fetched the first time a file of
 * its kind is formatted — from 0.2 MB (YAML) to 3.4 MB (the web's) — and never
 * by a page that does not format. JSON is VS Code's own formatter,
 * jsonc-parser, which keeps comments and writes every number as it was.
 *
 * Indented by the editor's indent, 4 spaces unless set to 2 (App.indent).
 * Go and Makefiles are tabs, whatever it is: gofmt and make say so.
 */

type Run = (text: string, name: string, indent: number) => string;

/** A formatter: the name a person knows it by, and how to fetch it. */
interface Formatter {
  name: string;
  load: () => Promise<Run>;
}

/**
 * Whatever a formatter throws — a string, an Error, an object — as one line,
 * saying where by line. Ruff and Mago say where by byte offset into the file
 * as UTF-8, and Mago what by the name of its Rust error.
 */
export function problemOf(e: unknown, text = ""): string {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e);
  let line = raw.split("\n").find((l) => l.trim())?.trim() ?? "it would not format";
  const lineAt = (offset: number) => {
    const bytes = new TextEncoder().encode(text).subarray(0, offset);
    return bytes.reduce((n, b) => n + Number(b === 10), 1);
  };
  const range = /\s*at byte range (\d+)\.\.\d+/.exec(line);
  if (range) line = `${line.slice(0, range.index)} on line ${lineAt(Number(range[1]))}`;
  const rust = /^([A-Z][A-Za-z]+)\(.*Position \{ offset: (\d+) \}/.exec(line);
  if (rust) line = `${rust[1]!.replace(/(?<!^)([A-Z])/g, " $1").toLowerCase()} on line ${lineAt(Number(rust[2]))}`;
  return line;
}

/** Loaded once, then the same promise for every file after. */
function once(load: () => Promise<Run>): () => Promise<Run> {
  let loading: Promise<Run> | null = null;
  return () => {
    loading ??= load().catch((e) => {
      loading = null;
      throw e;
    });
    return loading;
  };
}

const clang = once(async () => {
  const m = await import("@wasm-fmt/clang-format/vite");
  await m.default();
  return (text, name, indent) => {
    const java = /\.java$/i.test(name);
    const style = java
      ? { BasedOnStyle: "Google", IndentWidth: indent, ContinuationIndentWidth: indent * 2, ColumnLimit: 100 }
      : { BasedOnStyle: "LLVM", IndentWidth: indent };
    return m.format(text, name, JSON.stringify(style));
  };
});

const web = once(async () => {
  // Its ./vite entry is typed as the Node one, which has no init: it is the web one's.
  const m = (await import("@wasm-fmt/web_fmt/vite")) as unknown as typeof import("@wasm-fmt/web_fmt/web");
  await m.default();
  return (text, name, indent) => m.format(text, name, { indentStyle: "space", indentWidth: indent });
});

const FORMATTERS: Record<string, Formatter> = {
  python: {
    name: "Ruff",
    load: once(async () => {
      const m = await import("@wasm-fmt/ruff_fmt/vite");
      await m.default();
      return (text, name, indent) => m.format(text, name, { indent_style: "space", indent_width: indent });
    }),
  },
  clang: { name: "clang-format", load: clang },
  go: {
    name: "gofmt",
    load: once(async () => {
      const m = await import("@wasm-fmt/gofmt/vite");
      await m.default();
      return (text) => m.format(text);
    }),
  },
  web: { name: "Biome", load: web },
  json: {
    name: "jsonc-parser",
    load: once(async () => {
      const { applyEdits, format } = await import("jsonc-parser");
      return (text, _name, indent) => applyEdits(text, format(text, undefined, { tabSize: indent, insertSpaces: true, eol: "\n" }));
    }),
  },
  sql: {
    name: "sqlformat",
    load: once(async () => {
      const m = await import("@wasm-fmt/sql_fmt/vite");
      await m.default();
      return (text, _name, indent) => m.format(text, { indent_style: "space", indent_width: indent });
    }),
  },
  yaml: {
    name: "pretty_yaml",
    load: once(async () => {
      const m = await import("@wasm-fmt/yamlfmt/vite");
      await m.default();
      return (text, _name, indent) => m.format(text, { indent_width: indent });
    }),
  },
  toml: {
    name: "Taplo",
    load: once(async () => {
      const m = await import("@wasm-fmt/taplo_fmt/vite");
      await m.default();
      return (text, _name, indent) => m.format(text, { indent_string: " ".repeat(indent) });
    }),
  },
  markdown: {
    name: "dprint",
    load: once(async () => {
      const m = await import("@wasm-fmt/markdown/vite");
      await m.default();
      // Undefined is "leave it as it is"; paragraphs are never rewrapped.
      return (text) => m.format(text, {}) ?? text;
    }),
  },
  shell: {
    name: "shfmt",
    load: once(async () => {
      const m = await import("@wasm-fmt/shfmt/vite");
      await m.default();
      return (text, name, indent) => m.format(text, name, { indent });
    }),
  },
  php: {
    name: "Mago",
    load: once(async () => {
      const m = await import("@wasm-fmt/mago_fmt/vite");
      await m.default();
      return (text, name, indent) => m.format(text, name, { "tab-width": indent, "use-tabs": false });
    }),
  },
  lua: {
    name: "StyLua",
    load: once(async () => {
      const m = await import("@wasm-fmt/lua_fmt/vite");
      await m.default();
      return (text, _name, indent) => m.format(text, { indent_style: "space", indent_width: indent });
    }),
  },
};

/** By extension, lower case. */
const BY_EXTENSION: Record<string, keyof typeof FORMATTERS> = {
  py: "python", pyi: "python",
  c: "clang", h: "clang", cpp: "clang", cc: "clang", cxx: "clang", hpp: "clang", hh: "clang", hxx: "clang",
  java: "clang", cs: "clang", proto: "clang",
  go: "go",
  js: "web", mjs: "web", cjs: "web", jsx: "web", ts: "web", mts: "web", cts: "web", tsx: "web",
  css: "web", scss: "web", less: "web", html: "web", htm: "web", vue: "web", svelte: "web", graphql: "web", gql: "web",
  json: "json", jsonc: "json", webmanifest: "json", geojson: "json",
  sql: "sql",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  md: "markdown", markdown: "markdown",
  sh: "shell", bash: "shell",
  php: "php",
  lua: "lua",
};

function leafOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
  const leaf = leafOf(path);
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
}

/** What formats `path`, or null when nothing here does. */
export function formatterFor(path: string): Formatter | null {
  const key = BY_EXTENSION[extensionOf(path)];
  return key ? FORMATTERS[key]! : null;
}

/** Files indented with tabs whatever the editor's indent: Go, by gofmt, and Makefiles, by make. */
export function usesTabs(path: string): boolean {
  return extensionOf(path) === "go" || /^(GNU)?makefile$|\.mk$/i.test(leafOf(path));
}

/** `text` formatted as `path`'s kind, indented by `indent` spaces. Throws what the formatter said. */
export async function formatText(path: string, text: string, indent: number): Promise<string> {
  const formatter = formatterFor(path);
  if (!formatter) throw new Error(`nothing here formats a .${extensionOf(path) || leafOf(path)} file`);
  const run = await formatter.load();
  return run(text, leafOf(path), indent);
}
