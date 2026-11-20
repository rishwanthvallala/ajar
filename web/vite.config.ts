import { defineConfig, type Plugin } from "vite";

/**
 * The editor's files, named in the page so it can fetch them before they are
 * asked for (`EditorPane.warm`, src/workspace.ts).
 *
 * The editor is a chunk of its own, loaded when a file is first opened: a
 * megabyte compressed, which is the wait before that first file shows. The
 * page fetches it while it is idle instead — but a `modulepreload` needs the
 * files' names, which the build decides, and `import()` gives them only by
 * running the module, a tenth of a second of the page's thread. So the names
 * are written into the page here: the viewer's chunk and the one that makes
 * a file editable together, and every chunk and stylesheet they bring that
 * the page has not loaded already.
 */
function editorFiles(): Plugin {
  const MARK = "__AJAR_EDITOR_FILES__";
  return {
    name: "ajar-editor-files",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
      const lazy = ["/src/viewer.ts", "/src/editing.ts"].map((source) => {
        const chunk = chunks.find((c) => c.facadeModuleId?.replace(/\\/g, "/").endsWith(source));
        if (!chunk) this.error(`no chunk for ${source}: the page cannot name the editor's files`);
        return chunk!;
      });
      const closure = (from: string, into = new Set<string>()) => {
        if (into.has(from)) return into;
        into.add(from);
        const chunk = bundle[from];
        if (chunk?.type === "chunk") for (const next of chunk.imports) closure(next, into);
        return into;
      };
      const already = new Set<string>();
      for (const entry of chunks.filter((c) => c.isEntry)) closure(entry.fileName, already);
      const wanted = new Set<string>();
      for (const chunk of lazy) closure(chunk.fileName, wanted);
      const files: string[] = [];
      for (const name of wanted) {
        if (already.has(name)) continue;
        files.push(name);
        const styles = (bundle[name] as { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata?.importedCss;
        for (const css of styles ?? []) if (!files.includes(css)) files.push(css);
      }
      let written = 0;
      for (const chunk of chunks) {
        if (!chunk.code.includes(MARK)) continue;
        chunk.code = chunk.code.replaceAll(MARK, files.join(","));
        written++;
      }
      if (written === 0) this.error(`nothing in the build has ${MARK}: the editor would never be fetched ahead`);
    },
  };
}

export default defineConfig({
  plugins: [editorFiles()],
  server: {
    port: 5173,
    // Session links are /j/<id>; hand them all to the SPA.
    proxy: {},
  },
  appType: "spa",
  build: {
    outDir: "dist",
    // Off for the shipped build. Monaco's vendor maps were 42 MB of a 56 MB
    // deploy — rsynced every time, on a 20 GB disk — and the source they map
    // back to is public on GitHub anyway. `npm run build -- --sourcemap` when
    // something needs debugging against a production bundle.
    sourcemap: false,
  },
});
