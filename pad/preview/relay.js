/*
 * The pad's half of the preview's control page (/.wasmer/host.html), served
 * at /pad-preview.js beside the SDK's own (/wasmer-host.js).
 *
 * It carries what the pad says to the service worker (preview/sw.js): which
 * port a route reaches, and that this tab is back in front. It carries back
 * what the worker says: each page and request in the preview. A message from
 * the pad goes on with the pad's origin added. The worker puts that origin in
 * each page's frame-ancestors, and the page's script posts to it rather than
 * to anyone.
 *
 * It also sends the worker a word every twenty seconds. A browser stops a
 * service worker that has had nothing to do for about thirty, and the routes
 * are only in its memory. Idle for half a minute, the preview went dead, and
 * the next click in it reached nothing.
 */
const parentOrigin = new URLSearchParams(location.search).get("parentOrigin");

async function worker() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration?.active ?? null;
}

const ours = (message) => message && typeof message.type === "string" && message.type.startsWith("pad-preview:");

addEventListener("message", async (event) => {
  if (!parentOrigin || event.origin !== parentOrigin || !ours(event.data)) return;
  (await worker())?.postMessage({ ...event.data, padOrigin: parentOrigin });
});

navigator.serviceWorker.addEventListener("message", (event) => {
  if (!parentOrigin || !ours(event.data)) return;
  parent.postMessage(event.data, parentOrigin);
});
navigator.serviceWorker.startMessages();

setInterval(async () => (await worker())?.postMessage({ type: "pad-preview:ping" }), 20_000);
