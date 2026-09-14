/**
 * Ingress, step by step, with the failure text actually read.
 *
 * The service worker answers a failed route with `new Response(message, {
 * status: 502 })` — the body is the error. A previous attempt reported "502"
 * and stopped there, which is how this took two sessions instead of one.
 */
import { PACKAGES, Runtime } from "./runtime";

interface Step {
  stage: string;
  detail: string;
}

async function main() {
  const steps: Step[] = [];
  const say = (stage: string, detail: string) => {
    steps.push({ stage, detail });
    (window as unknown as { __steps: Step[] }).__steps = steps;
  };
  const params = new URLSearchParams(location.search);
  const host = params.get("host") ?? "";

  try {
    const rt = await Runtime.start(
      { "index.html": "<h1>served from the sandbox</h1>\n" },
      {
        shell: PACKAGES.shell,
        packages: [PACKAGES.coreutils, PACKAGES.python],
        network: { mode: "http" },
      },
    );
    const box = rt.sandbox();
    say("sandbox", "created with network mode=http");

    // Held as a live promise. Backgrounding with `&` exits the shell and takes
    // the server with it, and the sandbox then faults when a request arrives.
    // Which server, chosen by query so the two can be compared:
    //   http   python3 -m http.server, bound to loopback
    //   raw    a hand-rolled accept-and-reply loop
    const which = params.get("server") ?? "http";
    const raw = [
      "import socket",
      "s=socket.socket()",
      "s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)",
      "s.bind(('127.0.0.1',8000))",
      "s.listen(8)",
      "print('raw listening',flush=True)",
      "while True:",
      "    c,_=s.accept()",
      "    c.recv(65536)",
      // Length computed, not counted by hand: the first attempt said 11 for a
      // ten-byte body and the SDK refused it with "invalid internal data",
      // which is the correct answer to a malformed response.
      "    body=b'served from the sandbox'",
      "    head=b'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: %d\\r\\nConnection: close\\r\\n\\r\\n' % len(body)",
      "    c.sendall(head+body)",
      "    c.close()",
    ].join("\n");
    const serving =
      which === "raw"
        ? box.command("python3", ["-c", raw]).run({ check: false })
        : box.command("python3", ["-m", "http.server", "8000", "--bind", "127.0.0.1"]).run({ check: false });
    void serving.catch((e: Error) => say("server", `exited: ${e.message.slice(0, 120)}`));

    const listened = await new Promise<number | null>((resolve) => {
      const stop = box.ports.onListen((port) => {
        stop();
        resolve(port);
      });
      setTimeout(() => resolve(null), 20_000);
    });
    say("onListen", listened ? `port ${listened}` : "nothing listened");

    const server = await box.ports.expose(8000, { serviceWorker: host, timeoutMs: 30_000 });
    say("expose", server.url.href);
    (window as unknown as { __url: string }).__url = server.url.href;

    // The iframe is how this is meant to be consumed, and its load event does
    // not distinguish 200 from 502 — so the runner reads the response itself.
    const frame = server.createIframe();
    document.body.appendChild(frame);
    await new Promise((r) => setTimeout(r, 25_000));
    say("iframe", "attached");
  } catch (e) {
    say("error", (e as Error).message.slice(0, 300));
  }
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
