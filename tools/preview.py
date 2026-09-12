#!/usr/bin/env python3
"""Run the LuCI view on a laptop, with no router and no nlbwmon.

Nothing here reimplements the page. It writes synthetic history in the format
the sampler stores, aggregates it with the real nlbw-history-query, and runs
the real main.js behind stubs shaped like LuCI's E, rpc, uci, view and poll.

    python3 tools/preview.py                  # serve the page, click around
    python3 tools/preview.py --dark           # in LuCI's dark theme
    python3 tools/preview.py --screenshots    # rewrite docs/*.png instead

--dark, --days, --time-format and --date-format apply to both, so a screenshot
shows the same page serving would.

Served, the page is on http://127.0.0.1:8099 and its rpc calls run the query
script for real, so the device, protocol and period filters behave as they do
on a router. --days decides how much history there is to look at, and
?device=&protocol=&period= on the URL preselects a state worth returning to.
The page reports what it drew, and anything it throws, to this terminal.

--screenshots skips the server and writes the three images in docs/ through
headless Firefox. Those pages answer every rpc call from one baked fixture, so
they need no server, which is also why only units and hiding respond in them.

Needs python3-pil, and firefox for --screenshots. busybox is used for awk and
date when it is installed, which is what the router runs; otherwise the system
ones stand in.

Every window ends "now", so no two runs produce identical pixels: the clock
labels move. Regenerate the images when the page changed, not out of habit.
"""

import argparse
import collections
import json
import math
import os
import pathlib
import random
import shutil
import string
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = ROOT / "package/luci-app-nlbw-history/files"
QUERY = FILES / "usr/bin/nlbw-history-query"
VIEW = FILES / "www/luci-static/resources/view/nlbw-history/main.js"
DOCS = ROOT / "docs"

PERIOD = 60
PROTO_INTERVAL = 900

# A plausible household. share is the pull on the line when the device is busy.
DEVICES = [
    ("a4:83:e7:2c:11:04", "apple-tv",      "evening", 1.00, {"HTTPS": .55, "QUIC": .40, "DNS": .03, "NTP": .02}),
    ("dc:a6:32:7f:aa:19", "nas",           "night",   0.55, {"HTTPS": .30, "SMB": .60, "SSH": .08, "DNS": .02}),
    ("f0:18:98:41:3d:6b", "macbook-eliot", "work",    0.70, {"HTTPS": .62, "QUIC": .20, "SSH": .12, "DNS": .06}),
    ("8c:85:90:0e:77:22", "iphone-anna",   "all",     0.35, {"QUIC": .55, "HTTPS": .38, "DNS": .07}),
    ("b8:27:eb:19:5c:80", "pi-hole",       "flat",    0.05, {"DNS": .80, "HTTPS": .15, "NTP": .05}),
    ("00:17:88:6f:22:d1", "hue-bridge",    "flat",    0.02, {"HTTPS": .70, "NTP": .30}),
    ("e0:3f:49:55:90:1a", "workstation",   "work",    0.85, {"HTTPS": .50, "QUIC": .15, "SSH": .25, "SMB": .08, "DNS": .02}),
    ("ac:bc:32:71:0f:c3", "doorbell-cam",  "flat",    0.12, {"HTTPS": .95, "NTP": .05}),
]

NAS = "dc:a6:32:7f:aa:19"
BUSIEST = ["e0:3f:49:55:90:1a", "f0:18:98:41:3d:6b"]

# What --status prints, as the ucode backend parses it into key/value pairs.
STATUS = {"status": {
    "data_dir": "/srv/nlbw-history",
    "retention": "365 days",
    "flush_interval": "600 s",
    "protocols": "on, 900s buckets",
    "nlbwmon": "reachable, 8 device rows in the current period",
    "spool": "37 lines waiting",
    "stored": "14 day files, 4.7M on disk",
    "sampler": "running",
}}

# Close enough to LuCI's bootstrap themes to be honest about the layout. The
# page itself brings its own styling for everything it draws, and the charts
# paint in currentColor, so they follow the text without knowing the theme.
LIGHT = dict(scheme="light", bg="#f6f6f6", panel="#ffffff", border="#e3e3e3",
             rule="#dcdcdc", text="#212529", muted="#666666", label="#444444",
             link="#0069d9", row="#fafafa", line="#ededed", head="#555555",
             headrule="#dddddd", field="#ffffff", fieldborder="#cccccc")
DARK = dict(scheme="dark", bg="#101214", panel="#191c20", border="#2a2f36",
            rule="#2a2f36", text="#d7dde3", muted="#98a1aa", label="#b4bcc4",
            link="#6cb2ff", row="#1d2126", line="#262b31", head="#a7afb8",
            headrule="#333a42", field="#23272d", fieldborder="#3a4048")

CSS = string.Template("""
:root { color-scheme: $scheme }
body { margin: 0; background: $bg; color: $text;
       font: 14px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif }
#page { max-width: 1180px; margin: 0 auto; padding: 18px 22px 26px }
.cbi-map > h2 { font-size: 26px; font-weight: 400; margin: 0 0 14px; padding-bottom: 8px;
                border-bottom: 1px solid $rule; color: $link }
.cbi-section { background: $panel; border: 1px solid $border; border-radius: 3px;
               padding: 14px 16px; margin-bottom: 14px }
.cbi-section-descr { color: $muted; font-size: 13px }
label { font-size: 13px; color: $label }
select.cbi-input-select { font: inherit; font-size: 13px; padding: 4px 6px;
                          border: 1px solid $fieldborder; border-radius: 3px;
                          background: $field; color: $text }
a { color: $link; text-decoration: none }
.table { display: table; width: 100%; border-collapse: collapse; margin-top: 4px }
.tr { display: table-row }
.th, .td { display: table-cell; padding: 7px 10px; border-bottom: 1px solid $line;
           vertical-align: middle; font-size: 13px }
.table-titles .th { font-weight: 600; color: $head; border-bottom: 2px solid $headrule;
                    font-size: 12px }
.tr:nth-child(even) { background: $row }
input[type=checkbox] { width: 15px; height: 15px; accent-color: $link; margin: 0 }
svg { margin-bottom: 4px }
""")

# The view is a LuCI module body, so it runs as-is given the same globals LuCI
# passes it. E()'s contract matters: function-valued attributes are listeners.
BOOT = """
const _ = (s) => s;
function append(node, child) {
	if (child === null || child === undefined) return;
	if (Array.isArray(child)) { child.forEach((c) => append(node, c)); return; }
	node.appendChild(child instanceof Node ? child : document.createTextNode('' + child));
}
function E(tag, attrs, children) {
	const node = document.createElement(tag);
	if (attrs && (typeof attrs !== 'object' || Array.isArray(attrs) || attrs instanceof Node)) {
		children = attrs; attrs = null;
	}
	for (const k in (attrs || {})) {
		const v = attrs[k];
		if (v === null || v === undefined) continue;
		if (typeof v === 'function') node.addEventListener(k, v);
		else node.setAttribute(k, v);
	}
	append(node, children);
	return node;
}
const view = { extend: (proto) => proto };
const poll = { add: () => {} };
const L = { resolveDefault: (p, d) => p.catch(() => d) };
"""

# A screenshot is one fixed state, so every call answers from the same fixture.
STUBS_FIXED = """
const rpc = { declare: (o) => () => Promise.resolve(
	o.method === 'status' ? window.FIXTURE.status : window.FIXTURE.series) };
const uci = {
	load: () => Promise.resolve(),
	get: (cfg, sec, opt) => (window.FIXTURE.uci || {})[opt]
};
"""

# Served, the calls go to the real query script, so the filters do something.
# The first pair is answered from the embedded fixture so the page paints
# without waiting for anything; every call after that is a real query.
STUBS_LIVE = """
let pending = { status: window.FIXTURE.status, series: window.FIXTURE.series };
const rpc = { declare: (o) => function () {
	if (pending[o.method]) {
		const first = pending[o.method];
		pending[o.method] = null;
		return Promise.resolve(first);
	}
	const names = o.params || [];
	const q = new URLSearchParams();
	for (let i = 0; i < names.length; i++)
		q.set(names[i], arguments[i] === undefined ? '' : arguments[i]);
	return fetch('/' + o.method + '?' + q.toString()).then((r) => r.json()).then(function (d) {
		if (o.method === 'series')
			report('drew ' + d.mode + ', ' + d.buckets + ' bars of ' + d.step + 's');
		return d;
	});
} };
const uci = {
	values: window.FIXTURE.uci || {},
	load: function () {
		return fetch('/uci').then((r) => r.json()).then((v) => { uci.values = v; });
	},
	get: function (cfg, sec, opt) { return uci.values[opt]; }
};
function report(msg) { fetch('/log?m=' + encodeURIComponent(msg)); }
window.addEventListener('error', (e) => report('error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => report('rejected: ' + e.reason));
"""


def shape(kind, hour):
    if kind == "flat":    return 1.0
    if kind == "all":     return 0.35 + 0.65 * max(0, math.sin((hour - 7) / 24 * 2 * math.pi))
    if kind == "work":    return 1.0 if 9 <= hour < 18 else (0.25 if 7 <= hour < 22 else 0.04)
    if kind == "evening": return 1.0 if 19 <= hour < 24 else (0.15 if 17 <= hour < 19 else 0.02)
    if kind == "night":   return 1.0 if 2 <= hour < 5 else 0.18
    return 1.0


def write_history(work, days=1):
    """Samples in the two shapes the sampler appends, ending now."""
    random.seed(11)
    now = int(time.time()) // 60 * 60
    daydir = work / "days"
    daydir.mkdir(parents=True, exist_ok=True)
    day = lambda t: time.strftime("%Y-%m-%d", time.localtime(t))

    dev_rows = collections.defaultdict(list)
    pro_acc = collections.defaultdict(lambda: [0, 0])
    for ts in range(now - days * 86400 - 3600, now, PERIOD):
        lt = time.localtime(ts)
        hour = lt.tm_hour + lt.tm_min / 60
        for mac, name, kind, share, mix in DEVICES:
            level = shape(kind, hour) * share
            if random.random() > min(0.97, 0.25 + level):
                continue
            rx = int(level * random.lognormvariate(0, 0.8) * 9e6 * random.uniform(0.5, 1.5))
            tx = int(rx * random.uniform(0.05, 0.22))
            if rx < 2000:
                continue
            dev_rows[day(ts)].append("%d\t%s\t%d\t%d" % (ts, mac, rx, tx))
            bucket = ts - ts % PROTO_INTERVAL
            for proto, frac in mix.items():
                f = frac * random.uniform(0.7, 1.3)
                acc = pro_acc[(bucket, mac, proto)]
                acc[0] += int(rx * f)
                acc[1] += int(tx * f)

    for d, rows in dev_rows.items():
        (daydir / ("%s.tsv" % d)).write_text("\n".join(rows) + "\n")
    pro_rows = collections.defaultdict(list)
    for (bucket, mac, proto), (rx, tx) in sorted(pro_acc.items()):
        if rx > 0:
            pro_rows[day(bucket)].append("%d\t%s\t%s\t%d\t%d" % (bucket, mac, proto, rx, tx))
    for d, rows in pro_rows.items():
        (daydir / ("%s.proto.tsv" % d)).write_text("\n".join(rows) + "\n")

    # names come from the leases file, the same as on a router
    leases = "".join("%d %s 192.168.1.%d %s *\n" % (now + 43200, mac, 20 + i, name)
                     for i, (mac, name, *_) in enumerate(DEVICES))
    (work / "dhcp.leases").write_text(leases)
    (work / "run").mkdir(exist_ok=True)
    (work / "run" / "lastsample").write_text("%d\n" % (now - 9))
    return sum(len(v) for v in dev_rows.values())


def stub_query(work):
    """The real query script with its config reads replaced by fixtures."""
    out = []
    for line in QUERY.read_text().splitlines():
        if line.startswith(". /lib/functions.sh"):
            line = ":"
        elif line.startswith("config_load nlbw-history"):
            line = "DATA_DIR=%s/days; PERIOD=%d; PROTO_INTERVAL=%d" % (work, PERIOD, PROTO_INTERVAL)
        elif line.startswith("config_get "):
            continue
        line = line.replace("/tmp/dhcp.leases", str(work / "dhcp.leases"))
        line = line.replace("RUN=/tmp/nlbw-history", "RUN=%s/run" % work)
        out.append(line)
    path = work / "query.sh"
    path.write_text("\n".join(out) + "\n")
    return path


def run_query(work, query, args):
    env = dict(os.environ)
    if shutil.which("busybox"):
        env["PATH"] = "%s:%s" % (work / "bin", env["PATH"])
    sh = "busybox" if shutil.which("busybox") else "sh"
    cmd = ([sh, "sh"] if sh == "busybox" else [sh]) + [str(query)] + [str(a) for a in args]
    res = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if res.returncode != 0 or not res.stdout.strip():
        sys.exit("query failed: %s" % (res.stderr.strip() or "no output"))
    return json.loads(res.stdout)


def write_page(work, name, data, hidden=None, device="", protocol="", period="h24",
               live=False, formats=None, dark=False):
    src = VIEW.read_text()
    if "</script" in src:
        sys.exit("the view contains a </script>, which cannot be inlined as-is")
    status = json.loads(json.dumps(STATUS))
    status["status"]["last sample"] = time.strftime("%Y-%m-%d %H:%M:%S") + " (9s ago)"
    fixture = {"status": status, "series": dict(data, last_sample=int(time.time()) - 9),
               "uci": formats or {"time_format": "auto", "date_format": "auto"}}
    hidden = hidden or {"devices": [], "protocols": []}
    page = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Bandwidth History</title>
<style>%s</style></head><body><div id="page"></div>
<script id="viewsrc" type="text/plain">%s</script>
<script>
window.FIXTURE = %s;
try { localStorage.setItem('nlbw-history.hidden', %s); } catch (e) {}
%s
const mod = new Function('view', 'rpc', 'poll', 'uci', 'E', '_', 'L',
	document.getElementById('viewsrc').textContent)(view, rpc, poll, uci, E, _, L);
mod.load().then(function(res) {
	const body = mod.render(res);
	document.getElementById('page').appendChild(body);
	// show the filters the fixture was produced with; served, the page drives
	// its own selects because every change refetches for real
	if (!%s) {
		const sel = body.querySelectorAll('select');
		sel[0].value = %s; sel[1].value = %s; sel[2].value = %s;
	}
	if (typeof report === 'function') report('rendered');
	// served, ?device=&protocol=&period= drives the selects, so a state worth
	// looking at can be reloaded or linked to
	if (%s && location.search) {
		const p = new URLSearchParams(location.search);
		const sel = body.querySelectorAll('select');
		[ 'device', 'protocol', 'period' ].forEach(function (name, i) {
			const v = p.get(name);
			if (v === null) return;
			sel[i].value = v;
			sel[i].dispatchEvent(new Event('change'));
		});
	}
});
</script></body></html>""" % (CSS.substitute(DARK if dark else LIGHT), src, json.dumps(fixture), json.dumps(json.dumps(hidden)),
                              BOOT + (STUBS_LIVE if live else STUBS_FIXED),
                              json.dumps(bool(live)), json.dumps(device),
                              json.dumps(protocol), json.dumps(period), json.dumps(bool(live)))
    path = work / ("%s.html" % name)
    path.write_text(page)
    return path


def shoot(work, page, out):
    """Firefox headless, then trim the background below the content."""
    from PIL import Image
    raw = work / ("%s.raw.png" % out.stem)
    profile = work / "profile"
    profile.mkdir(exist_ok=True)
    subprocess.run(["firefox", "--headless", "-no-remote", "-profile", str(profile),
                    "--window-size=1280,1600", "--screenshot", str(raw), page.as_uri()],
                   capture_output=True, timeout=300)
    if not raw.exists():
        sys.exit("firefox produced no screenshot for %s" % page.name)
    im = Image.open(raw).convert("RGB")
    w, h = im.size
    bg = im.getpixel((5, h - 5))
    last = h - 1
    while last > 0 and all(im.getpixel((x, last)) == bg for x in range(0, w, 7)):
        last -= 1
    im = im.crop((0, 0, w, min(h, last + 20)))
    im.convert("P", palette=Image.ADAPTIVE, colors=128).save(out, optimize=True)
    print("  %-28s %sx%s  %d KiB" % (out.name, im.width, im.height, out.stat().st_size // 1024))


def serve(work, query, port, formats, dark):
    """Hand the page the real query output, so its filters actually filter."""
    import http.server
    import urllib.parse

    first = run_query(work, query, [24, 160, "", "", 0, ""])
    page = write_page(work, "live", first, live=True, formats=formats, dark=dark).read_bytes()

    class Handler(http.server.BaseHTTPRequestHandler):
        def send_json(self, obj):
            body = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(url.query)
            arg = lambda k, d="": (q.get(k) or [d])[0]
            if url.path == "/series":
                # the order the view's rpc.declare lists its params in
                self.send_json(run_query(work, query, [
                    arg("hours", 24), arg("buckets", 160), arg("mac"),
                    arg("protocol"), arg("end", 0), arg("hide")]))
            elif url.path == "/status":
                status = json.loads(json.dumps(STATUS))
                status["status"]["last sample"] = time.strftime("%Y-%m-%d %H:%M:%S")
                self.send_json(status)
            elif url.path == "/log":
                print("  page: %s" % arg("m"), file=sys.stderr, flush=True)
                self.send_response(204)
                self.end_headers()
            elif url.path == "/uci":
                self.send_json(formats)
            elif url.path in ("/", "/index.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.end_headers()
                self.wfile.write(page)
            else:
                self.send_error(404)

        def log_message(self, fmt, *a):
            # one compact line per call, so it is obvious what the page asked for
            print("  %s" % (fmt % a), file=sys.stderr, flush=True)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("serving the view on http://127.0.0.1:%d  (ctrl-c to stop)" % srv.server_address[1],
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("")


def finish(work, args):
    if args.work:
        print("kept %s" % work)
    else:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--screenshots", action="store_true",
                    help="write docs/*.png with headless Firefox instead of serving")
    ap.add_argument("--port", type=int, default=8099, metavar="N",
                    help="port to serve on (default 8099)")
    ap.add_argument("--days", type=int, default=7, metavar="N",
                    help="days of synthetic history to write (default 7, so the longer "
                         "periods have something to show)")
    ap.add_argument("--work", metavar="DIR",
                    help="build in DIR and leave it there, rather than in a temporary "
                         "directory that is deleted on exit; the synthetic day files and the "
                         "stubbed query script in it can be run by hand")
    ap.add_argument("--dark", action="store_true",
                    help="render in a dark theme, like LuCI's dark one")
    ap.add_argument("--time-format", default="auto", choices=("auto", "24", "12"),
                    help="what the page is told the clock setting is")
    ap.add_argument("--date-format", default="auto", choices=("auto", "dmy", "mdy"),
                    help="what the page is told the date order setting is")
    args = ap.parse_args()

    if args.screenshots and not shutil.which("firefox"):
        sys.exit("firefox is needed to rasterize the pages")
    try:
        import PIL  # noqa: F401
    except ImportError:
        sys.exit("python3-pil is needed")

    work = pathlib.Path(args.work).resolve() if args.work else pathlib.Path(tempfile.mkdtemp(prefix="nlbw-shots-"))
    work.mkdir(parents=True, exist_ok=True)
    if shutil.which("busybox"):
        binned = work / "bin"
        binned.mkdir(exist_ok=True)
        for tool in ("awk", "date"):
            p = binned / tool
            p.write_text('#!/bin/sh\nexec busybox %s "$@"\n' % tool)
            p.chmod(0o755)

    print("workdir %s" % work, flush=True)
    rows = write_history(work, days=args.days)
    print("  %d device rows of synthetic history" % rows, flush=True)
    query = stub_query(work)

    formats = {"time_format": args.time_format, "date_format": args.date_format}

    if not args.screenshots:
        serve(work, query, args.port, formats, args.dark)
        finish(work, args)
        return

    shots = [
        ("overview", dict(args=[24, 160, "", "", 0, ""]), {}),
        ("device", dict(args=[24, 160, NAS, "", 0, ""]), dict(device=NAS)),
        ("hidden", dict(args=[24, 160, "", "", 0, ",".join(BUSIEST)]),
         dict(hidden={"devices": BUSIEST, "protocols": []})),
    ]
    DOCS.mkdir(exist_ok=True)
    if args.dark:
        print("  note: writing dark images over the light ones the README uses")
    for name, q, page_args in shots:
        data = run_query(work, query, q["args"])
        page = write_page(work, name, data, formats=formats, dark=args.dark, **page_args)
        shoot(work, page, DOCS / ("graphs-%s.png" % name))

    finish(work, args)


if __name__ == "__main__":
    main()
