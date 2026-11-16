// What a check does on a site is marked as a check's, so that the site's usage
// counts — pads opened, programs run, people online — leave it out
// (crates/ajar-relay/src/usage.rs, `is_check`). These checks run against
// production too (`PAD_ORIGIN=…`), every browser a first visit, and until
// 16 November their visits were a good part of what those counts showed
// (scripts/usage-history.py).
//
// A cookie, because a browser sends it with the page's requests and its room's
// socket alike, and nothing in the page has to know.

export const CHECK_COOKIE = "ajar_check";

/**
 * `target` — a browser, or a context from `launchPersistentContext` — with
 * every context and page it makes from now on marked for `origin`.
 */
export async function marked(target, origin) {
  const mark = (context) => context.addCookies([{ name: CHECK_COOKIE, value: "1", url: origin }]);
  if (typeof target.addCookies === "function") {
    await mark(target);
    return target;
  }
  const newContext = target.newContext.bind(target);
  target.newContext = async (...args) => {
    const context = await newContext(...args);
    await mark(context);
    return context;
  };
  const newPage = target.newPage.bind(target);
  target.newPage = async (...args) => {
    const page = await newPage(...args);
    await mark(page.context());
    return page;
  };
  return target;
}
