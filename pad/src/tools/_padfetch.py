"""HTTP through the browser: the sandbox's half. The page's is src/fetch-bridge.ts.

The sandbox's sockets reach PyPI and nothing else (docs/dev/networking.md).
The browser around it reaches any site that answers web pages, so a request
is handed to the page, which makes it with fetch and hands back the answer —
the same way the fast javac is asked (src/javac/bridge.ts), through files in
.ajar/fetch, the one place both sides see:

    <id>.req     the request, renamed into place once written whole:
                 a line of JSON, then the body's bytes
    <id>.claim   the page has it
    <id>.ans     the answer, renamed into place by the page: a line of JSON,
                 then the body's bytes

What the browser will not do, nothing here can: a site that does not allow
web pages to read it (CORS) is refused, only https leaves an https page,
some headers are the browser's own, and the response's headers are only
those the site lets a page see.
"""

import json
import os
import time

DIR = "/workspace/.ajar/fetch"
# Long enough for a page busy with something else; the page looks every 40 ms
# while a command runs.
CLAIM_WAIT = 3.0
# Files from a request that was given up on, cleared by the next one.
STALE = 120.0


class Unanswered(Exception):
    """No page picked the request up: nothing was sent."""


class Failed(Exception):
    """The browser did not complete it. `code` is curl's number for what went wrong."""

    def __init__(self, message, code=7):
        super().__init__(message)
        self.code = code


class Answer:
    def __init__(self, head, body):
        self.status = head["status"]
        self.reason = head.get("statusText") or _reason(self.status)
        self.url = head["url"]
        self.redirected = head.get("redirected", False)
        self.headers = [tuple(h) for h in head.get("headers", [])]
        self.dropped = head.get("dropped", [])
        self.body = body


def _reason(status):
    try:
        import http

        return http.HTTPStatus(status).phrase
    except ValueError:
        return ""


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _clear_stale():
    try:
        names = os.listdir(DIR)
    except OSError:
        return
    now = time.time()
    for name in names:
        path = f"{DIR}/{name}"
        try:
            if now - os.stat(path).st_mtime > STALE:
                os.remove(path)
        except OSError:
            pass


def fetch(url, method="GET", headers=(), body=None, timeout=None, follow=True):
    """The answer to one request, made by the browser. Raises Unanswered or Failed.

    `follow`: whether a redirect is followed. The browser follows every one
    from a web site whatever this says; a request to the folder's own servers,
    at localhost, follows only if asked, so urllib and requests can follow
    them themselves, as they would, and curl shows a 303 and its Set-Cookie.
    """
    os.makedirs(DIR, exist_ok=True)
    _clear_stale()
    rid = f"{os.getpid()}-{time.time_ns()}-{os.urandom(3).hex()}"
    req, claim, ans = f"{DIR}/{rid}.req", f"{DIR}/{rid}.claim", f"{DIR}/{rid}.ans"
    head = {
        "url": url,
        "method": method,
        "headers": [[str(k), str(v)] for k, v in headers],
        "body": body is not None,
        "timeout": timeout,
        "follow": bool(follow),
    }
    with open(f"{req}.part", "wb") as f:
        f.write(json.dumps(head).encode("utf-8") + b"\n")
        if body is not None:
            f.write(body)
    os.rename(f"{req}.part", req)
    try:
        give_up = time.monotonic() + CLAIM_WAIT
        while not os.path.exists(claim):
            if time.monotonic() > give_up:
                raise Unanswered("no page picked the request up")
            time.sleep(0.01)
        # The page keeps to the timeout; this only stops waiting forever.
        give_up = time.monotonic() + (timeout + 10 if timeout else 24 * 3600)
        while not os.path.exists(ans):
            if time.monotonic() > give_up:
                raise Failed(f"Operation timed out after {timeout:g} seconds", 28)
            time.sleep(0.01)
        with open(ans, "rb") as f:
            data = f.read()
    finally:
        for path in (req, claim, ans):
            _remove(path)
    line, _, rest = data.partition(b"\n")
    answer = json.loads(line)
    if not answer.get("ok"):
        raise Failed(answer.get("error", "the browser did not complete the request"), answer.get("code", 7))
    return Answer(answer, rest)


def _seconds(timeout):
    """A timeout as one number of seconds, or None: urllib's, or requests' (connect, read)."""
    if isinstance(timeout, tuple):
        given = [t for t in timeout if t is not None]
        return sum(given) if given else None
    return timeout if isinstance(timeout, (int, float)) else None


def _bytes(data):
    """A request body as bytes, however the library holds it."""
    if data is None or isinstance(data, bytes):
        return data
    if isinstance(data, str):
        return data.encode("utf-8")
    if isinstance(data, (bytearray, memoryview)):
        return bytes(data)
    if hasattr(data, "read"):
        return _bytes(data.read())
    return b"".join(_bytes(chunk) for chunk in data)


def urllib_response(req):
    """urllib.request's answer to `req`, from the browser."""
    import io
    import http.client
    import urllib.error
    import urllib.response

    try:
        answer = fetch(req.full_url, req.get_method(), req.header_items(), _bytes(req.data), _seconds(req.timeout), follow=False)
    except Failed as e:
        raise urllib.error.URLError(str(e)) from None
    headers = http.client.HTTPMessage()
    for name, value in answer.headers:
        headers[name] = value
    response = urllib.response.addinfourl(io.BytesIO(answer.body), headers, answer.url, answer.status)
    response.msg = answer.reason
    response.reason = answer.reason
    return response


def requests_response(adapter, request, timeout):
    """requests' Response to `request`, from the browser."""
    import io
    from requests import exceptions
    from requests.models import Response
    from requests.structures import CaseInsensitiveDict
    from requests.utils import get_encoding_from_headers

    try:
        answer = fetch(request.url, request.method, request.headers.items(), _bytes(request.body), _seconds(timeout), follow=False)
    except Failed as e:
        kind = exceptions.Timeout if e.code == 28 else exceptions.ConnectionError
        raise kind(str(e), request=request) from None
    response = Response()
    response.status_code = answer.status
    response.reason = answer.reason
    response.headers = CaseInsensitiveDict(answer.headers)
    response.encoding = get_encoding_from_headers(response.headers)
    response.url = answer.url
    response.request = request
    response.connection = adapter
    response.raw = io.BytesIO(answer.body)
    response._content = answer.body
    response._content_consumed = True
    return response
