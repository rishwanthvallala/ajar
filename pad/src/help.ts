/**
 * /help: the user's guide, docs/use/pad.md, as a page of the site.
 *
 * "help" is a name the store keeps for the site, and until 20 October the
 * page said "That isn't a pad address": the guide was in the repository and
 * on no page, and with it the way out of the terminal, F6 (review of
 * 18 October). Built in, so it is the guide of the build that serves it.
 * Formatted as a pad's Markdown is (markdown.ts), sanitised the same way.
 */
import GUIDE from "../../docs/use/pad.md?raw";
import { footer, shell, topbar } from "./dashboard";
import { renderMarkdown, slug } from "./markdown";
import { el } from "./ui";

/** Where the guide's links to the rest of the documentation go. */
const DOCS = "https://github.com/rishwanthvallala/ajar/blob/main/docs/use/";

export async function startHelp(root: HTMLElement): Promise<void> {
  document.title = "Help — pad";
  const body = el("article", { className: "md-body" });
  const page = el("main", { className: "help" }, body);
  root.replaceChildren(shell(topbar(), page, footer()));
  body.append(await renderMarkdown(GUIDE, "pad.md", { image: async () => null, colorize: async () => null }));
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
