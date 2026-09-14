# CLAUDE.md

Notes for working on this repository. Most of it is about constraints that
aren't visible from the code itself.

## What this is

An OpenWrt LuCI app that gives per-device and per-protocol bandwidth history.
It does not measure traffic itself. It samples the cumulative counters that
`nlbwmon` already keeps, stores the delta between samples, and draws the
result. This is why it has no effect on software or hardware flow offloading,
which matters on the target hardware (Banana Pi R4). Do not replace this with
iptables/nftables counters or packet inspection.

## Layout

    package/luci-app-nlbw-history/Makefile          OpenWrt package definition
    package/luci-app-nlbw-history/files/            everything that gets installed
    build-ipk.sh                                    builds the .ipk without an SDK
    tools/preview.py                                runs the LuCI view with no router
    install.sh                                      installs onto a running router
    README.md                                       user-facing: install, config, troubleshooting
    DEVELOPMENT.md                                  build, CI and release procedure

Installed files:

    /usr/bin/nlbw-history-loop          procd service: sleep, sample, repeat
    /usr/bin/nlbw-history-collect       one sample; also --flush and --status
    /usr/bin/nlbw-history-query         aggregates stored samples into JSON
    /usr/share/rpcd/ucode/luci.nlbw_history.uc      ubus backend
    /www/luci-static/resources/view/nlbw-history/   the LuCI views

## How the data flows

1. `nlbw-history-loop` calls `nlbw-history-collect` every `period` seconds.
2. `nlbw-history-collect` queries nlbwmon twice (once grouped by MAC, once by
   MAC and protocol), diffs against the previous snapshot in `/tmp`, and
   appends deltas to spool files in `/tmp`.
3. Every `flush_interval` the spools are appended to day files under
   `data_dir`. Batching keeps flash writes down.
4. `nlbw-history-query` reads the day files **and the spools**, buckets by
   time, and prints JSON.
5. The ucode backend shells out to that script and passes the JSON through.
6. The LuCI view draws it.

Aggregation lives in awk on purpose. ucode is far slower over hundreds of
thousands of lines, so the backend stays thin.

## Hard constraints

**busybox.** Scripts run under busybox `ash` and busybox `awk`, not bash and
not gawk. No `[[`, no arrays, no `local`, no `gensub`, no `asort`, no
`strftime`. Sorting is hand-written insertion sort. Formatting timestamps is
done in shell, because busybox awk has no time functions. `date -D %s -d
"$epoch"` is the busybox spelling, with `date -d "@$epoch"` as the GNU
fallback; the `day_of()` helpers try both.

**Octal.** `$(date +%H)` yields `09`, which the shell reads as invalid octal in
arithmetic. Leading zeros are stripped with `${_h#0}` before any arithmetic.

**LuCI cannot make SVG with `E()`.** LuCI's `E()` helper uses
`document.createElement`, which produces a dead element for namespaced SVG
tags. Charts are therefore built as SVG *strings* and assigned via
`innerHTML`, which the HTML parser handles correctly. Do not "clean this up"
by switching to `E('svg', …)`; the chart will silently render nothing.

**ubus message size.** Everything the backend returns crosses ubus. Series are
bucketed server-side to at most 400 points and returned as bare number arrays.
A 30 day window is around 25 KB. Don't return raw samples.

**tmpfs.** On OpenWrt `/var` is a symlink to `/tmp`. Anything that must
survive a reboot goes under `data_dir`, and the settings form actively rejects
paths under `/tmp`, `/var`, `/proc`, `/sys` and `/dev`.

**Two resolutions on purpose.** Per-device rows are stored per sample. Per
protocol rows are aggregated into `protocol_interval` buckets (900s default),
because a row per device *per protocol* per sample is an order of magnitude
more data. `nlbw-history-query` clamps the bucket count when a protocol view
is requested so the bars stay contiguous rather than leaving gaps.

## nlbwmon facts, verified against upstream source

- `nlbw` is the same binary as `nlbwmon`, dispatched on `argv[0]`, at
  `/usr/sbin/nlbw`.
- `nlbw -c csv -q -n` prints a header row of column names, then **tab**
  separated, unquoted values. `-q` with no argument disables quoting.
- Column order changes with the grouping, so columns are always located by
  name from the header, never by position. With `-g mac` the columns are
  `mac conns rx_bytes rx_pkts tx_bytes tx_pkts`; with `-g mac,layer7` they are
  `proto port mac conns rx_bytes rx_pkts tx_bytes tx_pkts layer7`.
- `nlbw -c json` emits `{"columns":[…],"data":[[…]]}` on one line.
- Counters reset when nlbwmon rolls over to a new accounting period. A counter
  going backwards is treated as a reset and the current value is taken as the
  delta.
- nlbwmon records a flow only when exactly one endpoint is inside the
  configured subnets. Both-endpoints-local flows are skipped, so LAN-to-guest
  and device-to-router traffic never appears. Traffic to anything outside
  those subnets does appear, including multicast and broadcast.

## Conventions

- Bump `PKG_VERSION` in the package Makefile for any user-visible change, and
  update the version in the README title and install commands to match. There
  is no changelog in the repository: what changed goes in the GitHub release
  notes. `DEVELOPMENT.md` has the full release procedure; releasing is
  publishing a GitHub release, which is the only thing that builds and
  attaches the `.ipk`.
- Documentation is split by audience: anything a user of the package needs
  goes in `README.md`, anything only a contributor needs goes in
  `DEVELOPMENT.md`. Keep the README's troubleshooting section accurate, since
  it is the main diagnostic path for a device with no console.
- `nlbw-history-collect --status` is the single diagnostic entry point. It is
  surfaced by `/etc/init.d/nlbw-history status`, by the LuCI settings tab and
  by the history page status line. New failure modes should show up there.
- New config options need updating in four places: `files/etc/config/…`, the
  reader in the shell scripts, the settings form, and the README table.
- Build with `./build-ipk.sh`. It needs no OpenWrt SDK. The package is
  `PKGARCH:=all` because it contains no compiled code.

## Testing without a router

There is no test suite. What works:

- `sh -n` every shell script and `node --check` every JS file. CI does this.
- Stub `/usr/sbin/nlbw` with a script that prints plausible tab separated
  output, and a minimal `/lib/functions.sh` providing `config_load` and
  `config_get`, then run the collector for real.
- Generate synthetic day files and run `nlbw-history-query` against them to
  check timing, output size and all four filter combinations (no filter,
  device, protocol, both).
- The whole view runs outside a router: `python3 tools/preview.py` serves the
  real `history.js` behind LuCI shaped stubs, with its rpc calls answered by the
  real query script over synthetic history, so the filters work. Same script,
  `--screenshots`, writes the README images. Smaller pieces can also be
  evaluated in node directly, since `history.js` is a plain module body.

The two things that cannot be tested here are the ucode backend, which needs
rpcd, and the LuCI forms, which need a browser. Keep the ucode file small and
boring for that reason.

## Things that have already gone wrong

Worth not repeating:

- Storing history under `/var/lib`, which is RAM, so every reboot wiped it.
- Charting bytes-per-sample while labelling the axis as a rate, which was off
  by a factor of the sampling interval.
- Building charts with `E('svg', …)`, which renders nothing at all.
- A files-only package Makefile without an empty `Build/Compile`, which makes
  the default rule run `make` in an empty directory and fail.
- Forgetting `/tmp/luci-modulecache` when clearing LuCI caches, so a newly
  installed page stays invisible until something else invalidates it.
- **Leaving the `sleep` behind on shutdown.** procd signals the script, not the
  children it happens to be parked on, so `sleep "$_sleep" & wait $!` left a
  reparented `sleep` alive for the rest of the interval after every stop,
  restart and upgrade, and for up to an hour at a high `period`. The loop now
  keeps the pid and kills it from the trap. Note that `trap … INT` is inert
  whenever the script is started as a shell background job: `&` sets SIGINT and
  SIGQUIT to ignore, and a trap cannot be set for a signal already ignored on
  entry. procd sends TERM then KILL, so that is the path that matters, but it
  does mean a test harness using `&` cannot exercise the INT path at all.
- **An `rpc.declare` that named fewer params than the call site passed.** The
  live view declared `params: [ 'device' ]` and called it with a device and a
  service. LuCI maps positional arguments against that list by index, so the
  service was dropped on the floor: no error, no warning, the filter simply did
  nothing while the table still appeared to react. Every rpc signature is now
  checked against the ucode method's `args` in CI. Note that a test harness
  which stubs `rpc.declare` to resolve a fixed fixture cannot catch this at
  all, because it never exercises the argument mapping; the stub has to map
  positional arguments the way LuCI does and call the real backend.
