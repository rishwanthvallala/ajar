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
