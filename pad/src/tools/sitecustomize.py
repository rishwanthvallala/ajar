"""Imported by every python the pad starts, before the program: see SITE in shell.ts.

A thread cannot start in this runtime. The first `Thread.start()` traps inside
the WebAssembly engine ("table index is out of bounds"), and the program then
waits forever with nothing on screen: no error, no output, no end. Measured on
27 September with the python package exactly as the registry publishes it, so
it is the runtime and not anything the pad changed.

Refusing at `start()` turns that silence into a traceback that says why.
asyncio and subprocesses do not need threads, and both work.

Three things that wanted a thread, or a network the sandbox does not have,
are put right here — each only once its module is imported, so a python that
never uses them pays nothing for them:

- socketserver's ThreadingMixIn, under `python -m http.server` and
  http.server's ThreadingHTTPServer, serves each request in the thread that
  took it. It started a thread per request, refused above, so
  the server answered nothing — until 15 October `python -m http.server` was
  the one server everybody reaches for and the one that did not work.
- Werkzeug's development server — Flask's `app.run(debug=True)` and `flask
  run --debug` — runs without its reloader, which watches for changes on a
  thread. It said so with this file's traceback instead of serving.
- multiprocessing's resource tracker is not started. It is a process of its
  own, started by the first lock or shared value — Flask's debugger makes one
  — and while any process a program started is still running, ctrl-c here
  reaches that one and not the program: Flask kept serving, and its port
  stayed taken, after a ctrl-c that seemed to stop it. What the tracker would
  clean up goes with the sandbox anyway.
- urllib.request, and `requests` once pip has installed it, make their http
  and https requests through the browser, with its fetch (_padfetch.py). The
  sandbox's own sockets reach PyPI and nothing else; the browser reaches any
  site that answers web pages. pip keeps its sockets: it has its own copy of
  requests, which is left alone.
"""

import sys
import threading


def _refuse(self, *args, **kwargs):
    raise RuntimeError(
        "threads cannot start in the pad: the WebAssembly runtime it runs on "
        "stops the program when one does. asyncio and subprocess both work."
    )


threading.Thread.start = _refuse


# What to change in a module once it has loaded, by its name.
_FIXES = {}


def _when_imported(name):
    def register(fix):
        _FIXES[name] = fix
        return fix

    return register


class _Fixing:
    """A module's own loader, and the fix run after it."""

    def __init__(self, loader, fix):
        self._loader = loader
        self._fix = fix

    def create_module(self, spec):
        return self._loader.create_module(spec)

    def exec_module(self, module):
        self._loader.exec_module(module)
        self._fix(module)

    def __getattr__(self, name):
        return getattr(self._loader, name)


class _Finder:
    """First on sys.meta_path: finds nothing itself, and wraps what the others find."""

    @staticmethod
    def find_spec(name, path=None, target=None):
        fix = _FIXES.pop(name, None)
        if fix is None:
            return None
        for finder in sys.meta_path:
            if finder is _Finder or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None:
                if spec.loader is not None and hasattr(spec.loader, "exec_module"):
                    spec.loader = _Fixing(spec.loader, fix)
                return spec
        return None


sys.meta_path.insert(0, _Finder)


@_when_imported("socketserver")
def _serve_in_line(socketserver):
    # BaseServer's own: finish the request, then close it, right here.
    socketserver.ThreadingMixIn.process_request = socketserver.BaseServer.process_request


@_when_imported("werkzeug.serving")
def _no_reloader(serving):
    run_simple = serving.run_simple

    def run(*args, **kwargs):
        # run_simple(hostname, port, application, use_reloader, ...): asked
        # for in its place, or by name.
        if (len(args) > 3 and args[3]) or kwargs.get("use_reloader"):
            if len(args) > 3:
                args = (*args[:3], False, *args[4:])
            else:
                kwargs["use_reloader"] = False
            print(
                " * Reloader: off in the pad, which cannot start the thread it needs."
                " After a change, Ctrl-C and run it again.",
                file=sys.stderr,
                flush=True,
            )
        return run_simple(*args, **kwargs)

    serving.run_simple = run


@_when_imported("multiprocessing.resource_tracker")
def _no_tracker(resource_tracker):
    def nothing(*args, **kwargs):
        return None

    resource_tracker.ensure_running = nothing
    resource_tracker.register = nothing
    resource_tracker.unregister = nothing


@_when_imported("matplotlib.pyplot")
def _figures_shown_in_the_pad(pyplot):
    """plt.show(), with no window to show it in: each figure saved as a PNG
    beside the program, and the pad told to show it.

    MPLBACKEND=Agg (shell.ts) means drawing never reaches for a window
    system. What a person expects of show() is to see the plot, so it is
    saved as figure-<n>.png in the folder the program ran in, where the file
    tree shows it, and an escape the pad's terminal knows names the file so
    it opens over the editor. Then the figures are closed, as show() closes
    them once their windows are, so the next show() draws afresh.
    """
    import os
    import sys

    def show(*args, **kwargs):
        numbers = pyplot.get_fignums()
        for number in numbers:
            path = os.path.abspath(f"figure-{number}.png")
            pyplot.figure(number).savefig(path)
            if sys.stdout.isatty():
                sys.stdout.write(f"\x1b]7777;pad-image={path}\x07")
            print(f"(figure {number} saved as {os.path.relpath(path)})", flush=True)
        if numbers:
            pyplot.close("all")

    pyplot.show = show


@_when_imported("urllib.request")
def _urllib_through_the_page(request):
    import _padfetch

    def through(original):
        def open_(self, req):
            try:
                return _padfetch.urllib_response(req)
            except _padfetch.Unanswered:
                # No page answering — a command run some other way — so the
                # sandbox's own network, as it would have been.
                return original(self, req)

        return open_

    request.HTTPHandler.http_open = through(request.HTTPHandler.http_open)
    if hasattr(request, "HTTPSHandler"):
        request.HTTPSHandler.https_open = through(request.HTTPSHandler.https_open)


@_when_imported("requests.adapters")
def _requests_through_the_page(adapters):
    import _padfetch

    original = adapters.HTTPAdapter.send

    def send(self, request, stream=False, timeout=None, verify=True, cert=None, proxies=None):
        try:
            return _padfetch.requests_response(self, request, timeout)
        except _padfetch.Unanswered:
            return original(self, request, stream=stream, timeout=timeout, verify=verify, cert=cert, proxies=proxies)

    adapters.HTTPAdapter.send = send
