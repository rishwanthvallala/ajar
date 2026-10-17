/**
 * A Markdown file as it will look: README.md formatted, beside its source or
 * in place of it (App.paintMarkdown).
 *
 * marked turns the text into HTML, GitHub's flavour — tables, task lists,
 * strikethrough, bare links. DOMPurify then decides what of that HTML is
 * kept, and it is the part that matters: a pad's text is anyone's who can
 * edit it, Markdown may carry HTML of its own, and the page it is shown in
 * holds the viewer's session. Kept is what a document needs — headings,
 * lists, tables, code, links, images, <details> — and nothing that runs,
 * submits, or lays itself over the pad: no scripts or handlers, no forms, no
 * `style`, no SVG, and no `class` but a code block's language, since the
 * pad's own classes would let a file dress up as the pad's dialogs. Ids are
 * prefixed (`user-content-`, as GitHub does), so none can stand in for one of
 * the page's.
 *
 * What is left is made to work inside the pad: an image named relative to the
 * file comes from the pad's own files, as a `data:` URL, the only kind the
 * pad's CSP lets an image be; a code block is coloured by the editor's own
 * tokenizer; and links are followed by `followLink`, never by the page.
 */
import type { Config, DOMPurify } from "dompurify";
import type { Marked } from "marked";

/** Whether a file is Markdown, by its name. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdown|mkd|mkdn)$/i.test(path);
}

/** Past this a file is not formatted: too long to redo at every key. */
export const MARKDOWN_MAX = 2 * 1024 * 1024;

export interface MarkdownHooks {
  /** A pad file as a `data:` URL, to show as an image; null when there is none. */
  image(path: string): Promise<string | null>;
  /** A code block coloured as the editor would colour it, as HTML; null leaves it plain. */
  colorize(code: string, language: string): Promise<string | null>;
}

/** What renders, fetched the first time a file is shown formatted rather than with the page. */
let tools: Promise<{ marked: Marked; purify: DOMPurify }> | null = null;
function load() {
  return (tools ??= Promise.all([import("marked"), import("dompurify")]).then(([m, d]) => {
    const purify = d.default(window);
    purify.addHook("uponSanitizeAttribute", keepClass);
    return { marked: new m.Marked({ gfm: true, breaks: false }), purify };
  }));
}

function keepClass(node: Element, data: { attrName: string; attrValue: string; keepAttr: boolean }): void {
  // A code block's language, which marked writes as its class, and the
  // editor's token colours (mtk1, mtki…) on a span — no other class at all.
  if (data.attrName === "class") {
    data.keepAttr = node.nodeName === "CODE"
      ? /^language-[\w+#.-]{1,32}$/.test(data.attrValue)
      : node.nodeName === "SPAN" && /^mtk[\dibus]+( mtk[\dibus]+)*$/.test(data.attrValue);
  }
}
const KEEP: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "button", "textarea", "select", "option", "dialog", "video", "audio", "source", "track", "picture"],
  FORBID_ATTR: ["style", "target", "srcset", "ping", "formaction"],
  SANITIZE_NAMED_PROPS: true,
  ALLOW_DATA_ATTR: false,
};

/** What a link in the file points at, for `followLink`. */
export type Link =
  | { kind: "outside"; url: string }
  | { kind: "here"; id: string }
  | { kind: "file"; path: string; fragment: string }
  | { kind: "none" };

/** The pad path a link or an image written in `from` names, or null when it leaves the pad's folder. */
export function resolveIn(from: string, target: string): string | null {
  let path = target;
  try {
    path = decodeURIComponent(target);
  } catch {
    // As written, then.
  }
  const parts = path.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** What following `href`, written in the file `from`, would do. */
export function linkFor(from: string, href: string): Link {
  const trimmed = href.trim();
  if (!trimmed) return { kind: "none" };
  if (trimmed.startsWith("#")) return { kind: "here", id: trimmed.slice(1) };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme) return scheme === "http" || scheme === "https" || scheme === "mailto" ? { kind: "outside", url: trimmed } : { kind: "none" };
  if (trimmed.startsWith("//")) return { kind: "outside", url: `https:${trimmed}` };
  const hash = trimmed.indexOf("#");
  const fragment = hash < 0 ? "" : trimmed.slice(hash + 1);
  const path = resolveIn(from, trimmed.slice(0, hash < 0 ? undefined : hash).split("?")[0]!);
  return path ? { kind: "file", path, fragment } : { kind: "none" };
}

/** A heading's id, as GitHub makes them: `## Getting started` is `#getting-started`. */
export function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

/**
 * The file `path`, with text `source`, formatted: a fragment to put on
 * screen. Asynchronous for its images and its code blocks, which are filled
 * in before it returns, so it appears whole rather than repainting.
 */
export async function renderMarkdown(source: string, path: string, hooks: MarkdownHooks): Promise<DocumentFragment> {
  const { marked, purify } = await load();
  const html = marked.parse(source, { async: false }) as string;
  const fragment = purify.sanitize(html, { ...KEEP, RETURN_DOM_FRAGMENT: true });

  // Headings get ids to be linked to. Prefixed, as everything a file names
  // is; a link to `#setup` finds `md-setup` (App.followMarkdownLink).
  const seen = new Map<string, number>();
  for (const heading of fragment.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    const base = slug(heading.textContent ?? "") || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    heading.id = `md-${n ? `${base}-${n}` : base}`;
  }

  // A task list's boxes are drawn, not ticked: the file is what ticks them.
  for (const input of fragment.querySelectorAll<HTMLInputElement>("input")) {
    if (input.type !== "checkbox") input.remove();
    else input.disabled = true;
  }

  for (const a of fragment.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const link = linkFor(path, a.getAttribute("href") ?? "");
    if (link.kind === "outside") {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = a.title || a.href;
    } else if (link.kind === "file") a.title = a.title || `Open ${link.path}`;
  }

  // Wide tables scroll on their own rather than widening the page.
  for (const table of fragment.querySelectorAll("table")) {
    const wrap = document.createElement("div");
    wrap.className = "md-table";
    table.replaceWith(wrap);
    wrap.append(table);
  }

  const work: Promise<void>[] = [];
  for (const img of fragment.querySelectorAll<HTMLImageElement>("img")) {
    const src = img.getAttribute("src") ?? "";
    if (src.startsWith("data:image/")) continue;
    const link = linkFor(path, src);
    if (link.kind === "file") {
      work.push(hooks.image(link.path).then((url) => {
        if (url) img.src = url;
        else img.replaceWith(missing(`${img.alt || link.path} — no image ${link.path} in this pad`));
      }));
    } else if (link.kind === "outside") {
      // The pad's CSP lets no image in from another site, rightly: a file
      // could learn who opened it. A link to it instead.
      const a = document.createElement("a");
      a.className = "md-image-outside";
      a.href = link.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = img.alt ? `image: ${img.alt}` : "an image from another site";
      a.title = `${link.url} — images from other sites are not loaded here; this opens it`;
      img.replaceWith(a);
    } else img.replaceWith(missing(img.alt || "an image"));
  }

  for (const code of fragment.querySelectorAll<HTMLElement>("pre > code[class^='language-']")) {
    const language = code.className.slice("language-".length);
    const text = code.textContent ?? "";
    work.push(hooks.colorize(text, language).then((coloured) => {
      if (coloured === null) return;
      code.replaceChildren(purify.sanitize(coloured, { ALLOWED_TAGS: ["span", "br"], ALLOWED_ATTR: ["class"], RETURN_DOM_FRAGMENT: true }));
      code.parentElement?.classList.add("md-coloured");
    }).catch(() => {}));
  }
  await Promise.all(work);
  return fragment;
}

function missing(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "md-missing";
  span.textContent = text;
  return span;
}
