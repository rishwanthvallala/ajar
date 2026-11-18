/**
 * /help: the guide to sharing a machine, docs/use/ajar.md, as a page of the
 * site — as the pad's guide is a page of its own. Built in, so it is the
 * guide of the build that serves it. Formatted as a Markdown file in a
 * session is (@ajar/workspace-ui's markdown.ts), sanitised the same way.
 */
import GUIDE from "../../docs/use/ajar.md?raw";
import { renderMarkdown, slug } from "@ajar/workspace-ui/markdown";

/** Where the guide's links to the rest of the documentation go. */
const DOCS = "https://github.com/rishwanthvallala/ajar/blob/main/docs/use/";

export async function renderHelp(app: HTMLElement, themeButton: () => HTMLElement): Promise<void> {
  document.title = "Help · ajar";
  const body = document.createElement("article");
  body.className = "md-body";
  const page = document.createElement("main");
  page.className = "help";
  const head = document.createElement("header");
  head.className = "help-head";
  const home = document.createElement("a");
  home.href = "/";
  home.className = "help-home";
  home.textContent = "ajar";
  home.setAttribute("aria-label", "ajar — the front page");
  head.append(home, themeButton());
  page.append(head, body);
  app.replaceChildren(page);
  body.append(await renderMarkdown(GUIDE, "ajar.md", { image: async () => null, colorize: async () => null }));
  for (const a of body.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    // Within the page: to the heading's id, which renderMarkdown prefixes.
    if (href.startsWith("#")) a.setAttribute("href", `#md-${slug(decodeURIComponent(href.slice(1)))}`);
    // Elsewhere in the documentation: where it is published.
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      a.setAttribute("href", new URL(href, DOCS).href);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }
  if (location.hash) document.getElementById(`md-${slug(decodeURIComponent(location.hash.slice(1)))}`)?.scrollIntoView();
}
