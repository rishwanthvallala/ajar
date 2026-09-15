/**
 * Egress, and the limits on it, measured inside the sandbox.
 *
 * Two things have to be true at once and neither is worth much alone: `pip
 * install` reaches PyPI, and everything that is not PyPI is refused. The second
 * is what separates a package installer from an open proxy running on our
 * address, so it is asserted here rather than assumed from the configuration.
 */
import { mirrorPackages, PACKAGES, Runtime } from "./runtime";

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
  const url = new URLSearchParams(location.search).get("wisp") ?? "";

  // Without this the 59 MB python package comes from Wasmer's CDN rather than
  // this origin's mirror, which is slower and, under the COEP this page sets,
  // fails outright often enough to look like a network bug of our own.
  say("mirror", (await mirrorPackages()) ? "service worker is controlling" : "NOT controlling");

  try {
    const rt = await Runtime.start(
      {},
      {
        shell: PACKAGES.shell,
        packages: [PACKAGES.coreutils, PACKAGES.python],
        network: { mode: "wisp", url },
      },
    );
    say("runtime", `started against ${url}`);

    const py = async (code: string) => {
      const r = await rt.run("python", ["-c", code]);
      return `${r.stdout}${r.stderr}`.trim();
    };

    say("dns", await py(
      "import socket\ntry:\n print(socket.gethostbyname('pypi.org'))\nexcept Exception as e:\n print(type(e).__name__, e)",
    ));
    say("connect", await py(
      "import socket\ntry:\n s=socket.create_connection(('pypi.org',443),10);print('connected');s.close()\nexcept Exception as e:\n print(type(e).__name__, e)",
    ));
    // Raw I/O first. If bytes do not move, TLS failing says nothing about TLS.
    say("raw io", await py(
      "import socket\ntry:\n s=socket.create_connection(('pypi.org',443));s.sendall(b'hi\\r\\n\\r\\n');print('sent', len(s.recv(64)));s.close()\nexcept Exception as e:\n print(type(e).__name__, e)",
    ));
    // With a timeout, which puts the socket in non-blocking mode, and without,
    // which does not — a plausible difference under WASIX's poll.
    say("tls timeout", await py(
      "import socket,ssl\ntry:\n c=ssl.create_default_context()\n s=c.wrap_socket(socket.create_connection(('pypi.org',443),10),server_hostname='pypi.org')\n print('tls', s.version())\n s.close()\nexcept Exception as e:\n print(type(e).__name__, e)",
    ));
    say("tls blocking", await py(
      "import socket,ssl\ntry:\n c=ssl.create_default_context()\n s=c.wrap_socket(socket.create_connection(('pypi.org',443)),server_hostname='pypi.org')\n print('tls', s.version())\n s.close()\nexcept Exception as e:\n print(type(e).__name__, e)",
    ));

    // The allowlist, from the inside. A refusal here is the whole reason this
    // endpoint can exist at all.
    //
    // Tested by moving bytes, not by connecting. `create_connection` returns
    // successfully for a destination the server refused — the stream is opened
    // optimistically and the refusal only lands on first I/O — so a connect
    // that "works" proves nothing. An earlier version of this check reported an
    // open proxy on the strength of exactly that, while the server log showed
    // it refusing every one.
    const reach = (host: string, port: number) =>
      py(
        `import socket\ntry:\n s=socket.create_connection(('${host}',${port}),10)\n s.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n')\n d=s.recv(16)\n print('REACHED IT' if d else 'no data')\n s.close()\nexcept Exception as e:\n print(type(e).__name__, e)`,
      );
    say("blocked host", await reach("example.com", 443));
    say("blocked port", await reach("pypi.org", 80));
    say("allowed host still reaches", await reach("pypi.org", 443));

    // Into the pad's own folder, not the interpreter's.
    //
    // A plain `pip install` reports success and then the package is not
    // importable: python's site-packages lives under a read-only /nix/store
    // path, and the write lands in a layer that does not outlive the process.
    // `--target` puts it somewhere real, which also makes an installed package
    // part of the folder — it syncs, it survives a reload, and whoever opens
    // the link gets it too.
    const install = await rt.run("python", ["-m", "pip", "install", "--no-input", "--target", "/workspace/.deps", "six"]);
    say("pip install six", `${install.stdout}${install.stderr}`.trim().split("\n").slice(-4).join(" | "));
    say("where six went", (await rt.run("python", ["-m", "pip", "show", "-f", "six"])).stdout.split("\n").filter((l) => /^(Location|Name)/.test(l)).join(" | "));
    say("sys.path", await py("import sys;print([p for p in sys.path if p])"));
    say("import six", await py("import sys;sys.path.insert(0,'/workspace/.deps');import six;print('six', six.__version__)"));

    // `pip install requests` is deliberately not here. It pulls four more
    // packages, and somewhere in that the SDK's worker dies with
    // `WebAssembly.Module.imports(): Argument 0 must be a WebAssembly.Module`,
    // preceded by a run of `received a DATA packet for a stream which doesn't
    // exist` from the wisp client. It takes the whole runtime with it, so as a
    // check it does not fail — it hangs, and everything after it is lost.
    // Recorded in docs/open-points.md instead of asserted here.
  } catch (e) {
    say("threw", (e as Error).message);
  }
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
