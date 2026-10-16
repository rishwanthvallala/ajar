"""curl, made by the browser: `curl` and `wget` in shell.ts.

No curl is published for this runtime, and the sandbox's own network reaches
PyPI and nothing else. This one hands each request to the page, which makes
it with fetch (_padfetch.py), so it reaches any site that lets a web page read
it — most APIs do — and the browser's rules are its rules:

- https only, from an https page; a site that does not allow web pages
  (CORS) is refused, which is said in words, not as a hang
- except localhost, which is the folder's own servers — a Flask app running in
  another terminal — reached through the preview, as a program and not a page:
  plain http, no CORS, every header the server sends, and a redirect followed
  only with -L, as curl does. With no scheme given, a localhost address is
  http://, as curl assumes, and anything else https://
- redirects are always followed, as with -L, except from localhost (below)
- the browser sets some headers itself (Host, Cookie, Referer, User-Agent...)
  and drops ones given for them; -v says which
- a response shows only the headers the site lets a page see

The common options are here; anything else is refused by name rather than
ignored.
"""

import base64
import os
import sys
import time
import urllib.parse

import _padfetch

USAGE = """Usage: curl [options] <url>...
 -X, --request METHOD     the method (default GET, or POST with data)
 -H, --header 'K: V'      a request header; repeatable
 -d, --data DATA          a body, form-encoded; @file reads a file, @- stdin
     --data-raw DATA      the same, with no @ meaning
     --data-binary DATA   the same, sent exactly as given
     --data-urlencode D   name=value, its value url-encoded
     --json DATA          a JSON body, with its Content-Type and Accept
 -F, --form name=value    a multipart form field; name=@file sends a file
 -G, --get                put the data in the URL instead, as a GET
 -T, --upload-file FILE   PUT the file
 -u, --user USER:PASS     basic authentication
 -A, --user-agent NAME    (the browser keeps its own)
 -o, --output FILE        write the body to FILE
 -O, --remote-name        write it to a file named as the URL's last part
 -i, --include            the response's headers, then its body
 -I, --head               HEAD: the headers alone
 -f, --fail               no body and exit 22 for a status of 400 or over
 -s, --silent             no errors;  -S, --show-error  errors even then
 -v, --verbose            what was sent and received, on stderr
 -w, --write-out FORMAT   %{http_code} %{url_effective} %{content_type}
                          %{size_download} %{time_total} and \\n
 -m, --max-time SECONDS   give up after this long
 -L, --location           follow redirects: from localhost only when asked,
                          from a site always, since the browser does
 -k, --compressed         accepted: the browser checks certificates, and
                          decompresses
Made by the browser: https only, and only sites that let a web page read
them (CORS). See `curl --manual` for why."""

MANUAL = __doc__


class Usage(Exception):
    pass


def fail(code, message, quiet, show):
    if not quiet or show:
        print(f"curl: ({code}) {message}", file=sys.stderr)
    return code


def read_data(value, raw=False, binary=False):
    """What -d and its kin send: @file and @- unless raw, newlines kept only for binary."""
    if not raw and value.startswith("@"):
        name = value[1:]
        data = sys.stdin.buffer.read() if name == "-" else open(name, "rb").read()
        if not binary:
            data = data.replace(b"\r", b"").replace(b"\n", b"")
        return data
    return value.encode("utf-8")


def multipart(fields):
    boundary = "----pad" + os.urandom(12).hex()
    out = []
    for field in fields:
        name, _, value = field.partition("=")
        out.append(f"--{boundary}\r\n".encode())
        if value.startswith("@"):
            path = value[1:].split(";")[0]
            out.append(f'Content-Disposition: form-data; name="{name}"; filename="{os.path.basename(path)}"\r\n'.encode())
            out.append(b"Content-Type: application/octet-stream\r\n\r\n")
            out.append(open(path, "rb").read())
        else:
            out.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
            out.append(value.encode("utf-8"))
        out.append(b"\r\n")
    out.append(f"--{boundary}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


# Options that take a value, by every name they go by.
VALUED = {
    "-X": "request", "--request": "request",
    "-H": "header", "--header": "header",
    "-d": "data", "--data": "data", "--data-ascii": "data",
    "--data-raw": "data-raw", "--data-binary": "data-binary", "--data-urlencode": "data-urlencode",
    "--json": "json",
    "-F": "form", "--form": "form",
    "-T": "upload", "--upload-file": "upload",
    "-u": "user", "--user": "user",
    "-A": "agent", "--user-agent": "agent",
    "-e": "referer", "--referer": "referer",
    "-o": "output", "--output": "output",
    "-w": "write-out", "--write-out": "write-out",
    "-m": "max-time", "--max-time": "max-time", "--connect-timeout": "max-time",
    "--url": "url",
    "--retry": "ignored", "--retry-delay": "ignored", "--retry-max-time": "ignored",
}
FLAGS = {
    "-O": "remote-name", "--remote-name": "remote-name",
    "-i": "include", "--include": "include",
    "-I": "head", "--head": "head",
    "-f": "fail", "--fail": "fail", "--fail-with-body": "fail-with-body",
    "-s": "silent", "--silent": "silent",
    "-S": "show-error", "--show-error": "show-error",
    "-v": "verbose", "--verbose": "verbose",
    "-G": "get", "--get": "get",
    "-L": "location", "--location": "location",
    "-k": "ignored", "--insecure": "ignored",
    "--compressed": "ignored", "-#": "ignored", "--progress-bar": "ignored", "--no-progress-meter": "ignored",
    "--create-dirs": "create-dirs",
    "-h": "help", "--help": "help", "-M": "manual", "--manual": "manual",
    "-V": "version", "--version": "version",
}


def parse(argv):
    opts = {"header": [], "data": [], "form": [], "urls": []}
    i = 0
    while i < len(argv):
        arg = argv[i]
        i += 1
        if arg == "--":
            opts["urls"].extend(argv[i:])
            break
        if arg.startswith("--"):
            name, eq, inline = arg.partition("=")
            if name in VALUED:
                if eq:
                    value = inline
                elif i < len(argv):
                    value = argv[i]
                    i += 1
                else:
                    raise Usage(f"option {name}: requires parameter")
                take(opts, VALUED[name], value)
            elif name in FLAGS:
                opts[FLAGS[name]] = True
            else:
                raise Usage(f"option {name}: is not supported here")
        elif arg.startswith("-") and len(arg) > 1:
            # Short options run together, as -sSL or -fsSLo out.
            j = 1
            while j < len(arg):
                short = "-" + arg[j]
                j += 1
                if short in VALUED:
                    if j < len(arg):
                        value = arg[j:]
                    elif i < len(argv):
                        value = argv[i]
                        i += 1
                    else:
                        raise Usage(f"option {short}: requires parameter")
                    take(opts, VALUED[short], value)
                    break
                if short in FLAGS:
                    opts[FLAGS[short]] = True
                else:
                    raise Usage(f"option {short}: is not supported here")
        else:
            opts["urls"].append(arg)
    return opts


def take(opts, key, value):
    if key == "header":
        opts["header"].append(value)
    elif key in ("data", "data-raw", "data-binary", "data-urlencode", "json"):
        opts["data"].append((key, value))
    elif key == "form":
        opts["form"].append(value)
    elif key == "url":
        opts["urls"].append(value)
    elif key != "ignored":
        opts[key] = value


def body_of(opts):
    """The request body and the headers it implies, from -d and its kin, -F or -T."""
    implied = []
    if opts["form"]:
        body, kind = multipart(opts["form"])
        return body, [("Content-Type", kind)]
    if opts.get("upload"):
        return open(opts["upload"], "rb").read(), implied
    if not opts["data"]:
        return None, implied
    parts = []
    for key, value in opts["data"]:
        if key == "data-urlencode":
            name, eq, content = value.partition("=")
            parts.append((f"{name}=" if eq else "").encode() + urllib.parse.quote_plus(content if eq else name).encode())
        elif key == "json":
            parts.append(read_data(value, binary=True))
        else:
            parts.append(read_data(value, raw=key == "data-raw", binary=key == "data-binary"))
    if any(key == "json" for key, _ in opts["data"]):
        return b"".join(parts), [("Content-Type", "application/json"), ("Accept", "application/json")]
    return b"&".join(parts), [("Content-Type", "application/x-www-form-urlencoded")]


def write_out(fmt, answer, url, size, seconds):
    values = {
        "http_code": str(answer.status if answer else 0),
        "response_code": str(answer.status if answer else 0),
        "url_effective": answer.url if answer else url,
        "content_type": next((v for k, v in (answer.headers if answer else []) if k.lower() == "content-type"), ""),
        "size_download": str(size),
        "time_total": f"{seconds:.6f}",
        "num_redirects": "1" if answer and answer.redirected else "0",
    }
    out = fmt.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
    for name, value in values.items():
        out = out.replace("%{" + name + "}", value)
    return out


LOCAL = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def one(url, opts):
    quiet, show = opts.get("silent", False), opts.get("show-error", False)
    if "://" not in url:
        local = urllib.parse.urlsplit("//" + url).hostname in LOCAL
        url = ("http://" if local else "https://") + url
    scheme = url.split("://", 1)[0].lower()
    if scheme not in ("http", "https"):
        return fail(1, f'Protocol "{scheme}" not supported here: the browser makes http and https requests', quiet, show)

    body, headers = body_of(opts)
    if opts.get("get") and body is not None:
        url += ("&" if "?" in url else "?") + body.decode("utf-8", "replace")
        body = None
    # curl's own rules: `K: V` sets it, `K:` takes it away, `K;` sends it empty.
    for line in opts["header"]:
        empty = ":" not in line and line.rstrip().endswith(";")
        name, _, value = line.rstrip().rstrip(";").partition(":") if empty else line.partition(":")
        name = name.strip()
        headers = [(k, v) for k, v in headers if k.lower() != name.lower()]
        if value.strip() or empty:
            headers.append((name, value.strip()))
    if opts.get("user"):
        token = base64.b64encode(opts["user"].encode("utf-8")).decode()
        headers.append(("Authorization", f"Basic {token}"))
    if opts.get("agent"):
        headers.append(("User-Agent", opts["agent"]))
    if opts.get("referer"):
        headers.append(("Referer", opts["referer"]))
    if not any(k.lower() == "accept" for k, _ in headers):
        headers.append(("Accept", "*/*"))

    method = opts.get("request") or ("HEAD" if opts.get("head") else "PUT" if opts.get("upload") else "POST" if body is not None else "GET")
    timeout = float(opts["max-time"]) if opts.get("max-time") else None

    verbose = opts.get("verbose", False)
    if verbose:
        parsed = urllib.parse.urlsplit(url)
        if parsed.hostname in LOCAL:
            print(f"* Through the preview, to the folder's server on port {parsed.port or 80}", file=sys.stderr)
        else:
            print(f"* Made by the browser, with fetch: it connects, and checks the certificate", file=sys.stderr)
        print(f"> {method} {parsed.path or '/'}{'?' + parsed.query if parsed.query else ''}", file=sys.stderr)
        print(f"> Host: {parsed.netloc}", file=sys.stderr)
        for k, v in headers:
            print(f"> {k}: {v}", file=sys.stderr)
        print(">", file=sys.stderr)

    started = time.monotonic()
    try:
        answer = _padfetch.fetch(url, method, headers, body, timeout, follow=opts.get("location", False))
    except _padfetch.Unanswered:
        return fail(7, "the page did not pick the request up: curl works from the pad's terminal and Run", quiet, show)
    except _padfetch.Failed as e:
        return fail(e.code, str(e), quiet, show)
    seconds = time.monotonic() - started

    if verbose:
        if answer.dropped:
            print(f"* The browser sets these itself, so they were not sent: {', '.join(answer.dropped)}", file=sys.stderr)
        if answer.redirected:
            print(f"* Followed a redirect to {answer.url}", file=sys.stderr)
        print(f"< HTTP/1.1 {answer.status} {answer.reason}".rstrip(), file=sys.stderr)
        for k, v in answer.headers:
            print(f"< {k}: {v}", file=sys.stderr)
        print("<", file=sys.stderr)

    failing = answer.status >= 400 and (opts.get("fail") or opts.get("fail-with-body"))
    head = f"HTTP/1.1 {answer.status} {answer.reason}".rstrip() + "\r\n"
    head += "".join(f"{k}: {v}\r\n" for k, v in answer.headers) + "\r\n"
    out = b""
    if opts.get("include") or opts.get("head"):
        out += head.encode("utf-8")
    if not opts.get("head") and not (failing and not opts.get("fail-with-body")):
        out += answer.body

    target = opts.get("output")
    if opts.get("remote-name") and not target:
        target = os.path.basename(urllib.parse.urlsplit(answer.url).path) or "index.html"
    if target and target != "-":
        if opts.get("create-dirs") and os.path.dirname(target):
            os.makedirs(os.path.dirname(target), exist_ok=True)
        try:
            with open(target, "wb") as f:
                f.write(out)
        except OSError as e:
            return fail(23, f"Failure writing output to destination: {e.strerror}", quiet, show)
    elif out:
        if sys.stdout.isatty() and b"\0" in out[:4096]:
            print("Warning: Binary output can mess up your terminal. Use \"--output -\" to tell curl to output it to your terminal anyway, or consider \"--output <FILE>\" to save to a file.", file=sys.stderr)
        else:
            sys.stdout.flush()
            sys.stdout.buffer.write(out)
            sys.stdout.buffer.flush()

    if opts.get("write-out"):
        sys.stdout.write(write_out(opts["write-out"], answer, url, len(answer.body), seconds))
        sys.stdout.flush()
    if failing:
        return fail(22, f"The requested URL returned error: {answer.status}", quiet, show)
    return 0


def main(argv):
    try:
        opts = parse(argv)
    except Usage as e:
        print(f"curl: {e}\ncurl: try 'curl --help' for more information", file=sys.stderr)
        return 2
    if opts.get("help"):
        print(USAGE)
        return 0
    if opts.get("manual"):
        print(MANUAL)
        return 0
    if opts.get("version"):
        print("curl (the pad's, made by the browser with fetch)\nProtocols: http https")
        return 0
    if not opts["urls"]:
        print("curl: no URL specified\ncurl: try 'curl --help' for more information", file=sys.stderr)
        return 2
    code = 0
    for url in opts["urls"]:
        try:
            code = one(url, opts) or code
        except OSError as e:
            code = fail(26, f"Failed to open/read local data: {e.strerror}: {e.filename}", opts.get("silent"), opts.get("show-error"))
    return code


def wget(argv):
    """wget's commonest lines — `wget URL`, `-O file`, `-q`, `-O -` — as curl."""
    out, quiet, urls = None, False, []
    i = 0
    while i < len(argv):
        arg = argv[i]
        i += 1
        if arg in ("-O", "--output-document") and i < len(argv):
            out = argv[i]
            i += 1
        elif arg.startswith("--output-document="):
            out = arg.split("=", 1)[1]
        elif arg in ("-q", "--quiet"):
            quiet = True
        elif arg.startswith("-"):
            print(f"wget: {arg}: is not supported here; try curl", file=sys.stderr)
            return 2
        else:
            urls.append(arg)
    if not urls:
        print("wget: missing URL", file=sys.stderr)
        return 1
    code = 0
    for url in urls:
        name = out or os.path.basename(urllib.parse.urlsplit(url if "://" in url else "https://" + url).path) or "index.html"
        opts = {"header": [], "data": [], "form": [], "urls": [url], "output": name, "fail": True, "silent": quiet, "show-error": True, "location": True}
        result = one(url, opts)
        if result == 0 and not quiet and name != "-":
            print(f"saved {name}", file=sys.stderr)
        code = result or code
    return code


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--as-wget":
        sys.exit(wget(sys.argv[2:]))
    sys.exit(main(sys.argv[1:]))
