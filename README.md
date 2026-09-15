# luci-app-nlbw-history 1.0.11

Historical per-device bandwidth graphs for OpenWrt, built on the counters
`nlbwmon` already collects. It samples nlbwmon on a timer, stores the delta
between samples, and draws it in LuCI under **Services → Bandwidth History**,
with a *History* tab, a *Live* tab and a *Settings* tab.

The history only talks to nlbwmon over its control socket. The Live tab reads
conntrack directly and stores nothing. Neither does packet inspection, adds a
firewall rule, or has any effect on software or hardware flow offloading.

![The history page, every device stacked over the last 24 hours](docs/history-overview.png)

The page shows every device stacked, so you can see who was using the line at
any moment. Two filters change what gets stacked:

- nothing selected: one band per device, at full sampling resolution
- a device selected: one band per protocol, so you can see what that device
  was actually doing
- a protocol selected: one band per device, so you can see who was using it

Either filter can also be set by clicking a row in the table underneath.

![One device selected, so the chart stacks by protocol instead](docs/history-device.png)

One device can easily pull a hundred times what the rest of the house does,
and a stacked chart scaled to it flattens everything else onto the baseline.
Untick that device in the **Chart** column of the table, or click its entry in
the legend, and it drops out of the graph so the remaining bands can use the
full height. Hidden series are dropped before the top eight are picked, so
hiding the biggest one also brings a further device up out of *Other*. The
table keeps listing them, greyed out, with their real totals: it reports what
was recorded, not what is drawn. The choice is remembered in the browser, per
device and, when a device is selected, per protocol; **show all** above the
graph clears it.

![The same window with the two busiest devices hidden, so the rest can use the full height](docs/history-hidden.png)

The period dropdown holds the usual relative windows, up to the last 30 days,
and below them one entry per calendar month that retention can still reach. A
long history is therefore read a month at a time: the window never gets wider
than about a month, which is what keeps a query affordable on a router.

## Live view

The **Live** tab answers a different question: what is moving *right now*. It
reads conntrack directly instead of nlbwmon, stores nothing at all, and samples
only while the page is open. Close the tab and the sampler shuts itself down.

The two dropdowns work like the ones on the history page, and the names in the
table are the quick route into them: pick a device and the chart restacks by
protocol, pick a protocol and it restacks by the devices using it. Clicking a
name in the table sets the same filter. The **Units** dropdown switches the
rates between bits and bytes per second, `Mbit/s` by default because that is
how link speeds are quoted. The Total column stays in bytes either way, since
it is a volume and not a rate.

Protocols here are named from the connection's destination port, looked up in
three places:

1. `/usr/share/nlbwmon/protocols`, so a protocol is called the same thing here
   as on the history page. That matters more than it sounds: nlbwmon calls
   443/udp QUIC and 80/tcp HTTP where `/etc/services` says `https` and `www`.
2. `/etc/services`, for the many ports nlbwmon does not carry. It has around
   170 entries against nlbwmon's 46.
3. the port itself, as `tcp:27015`, when neither knows it.

That is a port lookup, not deep packet inspection, so it says what a
connection looks like rather than what it is. Anything on 443 reads as HTTPS
whatever is inside it.

nlbwmon cannot drive this. It folds ongoing connections into its counters on
its own `refresh_interval`, 30 seconds by default, so a per-second graph built
on it would be twenty-nine empty bars and one spike. conntrack is much fresher:
the kernel's flowtable garbage collector runs every second and asks the driver
for offloaded connections' counters once a flow has aged past a tenth of
`net.netfilter.nf_conntrack_tcp_timeout_offload`. That sysctl defaults to 30
seconds, so **offloaded traffic reaches conntrack in roughly 3 second steps**.

That is the real floor on resolution, not the poll rate. Bars finer than about
3 seconds need the sysctl lowered too:

    sysctl -w net.netfilter.nf_conntrack_tcp_timeout_offload=10

The same value decides when an idle offloaded connection is dropped from the
flowtable, so low numbers churn it harder. 10 is a reasonable floor.

It counts the same traffic the History page does, because it applies nlbwmon's
own rule off nlbwmon's own config: a flow is counted only when **exactly one**
end is inside `local_network` in `/etc/config/nlbwmon`. Interface names there
are resolved the way nlbwmon's init script resolves them. So LAN to LAN
transfers and traffic to the router itself never appear on either page, and
neither does traffic between two remote hosts.

If that list cannot be resolved, the live page falls back to treating anything
in the neighbour table as local, which counts slightly too much rather than
showing nothing at all. `nlbw-history-live --status` says which of the two is
in effect and lists the subnets it found.

The chart always spans the whole `live_window`, even before that much has been
collected, so the bars keep their width instead of starting enormous and
shrinking with every poll until the window fills.

Counters for an offloaded connection do not move smoothly. The kernel folds the
hardware counters in roughly every three seconds, per flow and on each flow's
own phase, so reading them every few seconds aliases: an empty bar, then a
double one, over and over. There is nothing to synchronise to and no event to
wait for, so instead each reading is spread across the span it actually
accumulated in. Totals stay exact, the empty bars go away, and a burst is
smeared back over at most ten seconds rather than over a genuinely quiet
stretch.

The bars sit on absolute clock boundaries rather than being measured back from
whenever the page last polled. Measured back, the grid shifts a fraction of a
bar on every poll and every sample lands in a different bucket, so bars deep in
the past change for no reason and two browsers open on the same router draw
different charts from identical data.

Two things the live view is not. It is not accounting: a connection that opens
and closes between two samples is never seen, which is why the history graphs
keep using nlbwmon, the only thing here that subscribes to conntrack's teardown
events. And it needs byte counters in conntrack, which the page tells you
about if they are off:

    sysctl -w net.netfilter.nf_conntrack_acct=1

Working on it rather than running it? See [DEVELOPMENT.md](DEVELOPMENT.md)
for the build, the CI and the release procedure.

## What gets counted is nlbwmon's decision

This package measures nothing. It reads the counters `nlbwmon` already keeps,
stores the difference between two readings, and draws it. Everything about
*what* is in those counters therefore comes from nlbwmon's own configuration,
not from anything here:

- **which traffic is accounted at all.** nlbwmon has a list of local networks,
  and it records a flow only when exactly one of its two endpoints is inside
  them. Traffic with both endpoints local is skipped, so LAN to guest, or a
  device talking to the router itself, never appears here. Traffic to anything
  outside those networks does appear, multicast and broadcast included.
- **which interfaces and subnets those are.** A device that never shows up in
  the graphs is usually on a network nlbwmon was not told about.
- **the protocol names.** *HTTPS*, *QUIC*, *SMB* and the rest are nlbwmon's
  layer 7 classification, from its own protocol list. This page only stacks
  what it is handed, so a protocol you expect to see is a question for
  nlbwmon, and so is one you see named *unknown*.
- **when the counters reset.** nlbwmon keeps an accounting period and rolls
  over to a new one; the sampler treats a counter going backwards as a reset
  and counts the new value as the traffic since. History already stored is
  unaffected, so the graphs survive a rollover that the nlbwmon page itself
  will show as a fresh start.

All of that is changed on nlbwmon's side, through its own LuCI page if
`luci-app-nlbwmon` is installed, or in `/etc/config/nlbwmon`, followed by
`/etc/init.d/nlbwmon restart`. Nothing in **Bandwidth History → Settings**
changes what is accounted: those options only decide how often this package
reads the counters and how long it keeps what it read.

Changing nlbwmon's configuration does not rewrite history either. It applies
from the next sample on, so a graph can straddle a change, showing devices or
protocols on one side of it that are absent on the other.

## Requirements

`nlbwmon` and `rpcd-mod-ucode`. On OpenWrt 25.12 and newer:

    apk add nlbwmon rpcd-mod-ucode

On 24.10 and older:

    opkg install nlbwmon rpcd-mod-ucode

Developed and verified on 24.10. 25.12 replaced opkg with apk and gets its own
package below; nothing else about this release is specific to a version, but it
has not been run on 25.12 hardware.

## Install

**Option A: the prebuilt package.** Both are architecture independent, so the
same file works on any target. Take the one your release can install, from the
[Releases](../../releases) page.

OpenWrt 25.12 and newer, `luci-app-nlbw-history-<version>.apk`:

    scp luci-app-nlbw-history-1.0.11-r1.apk root@192.168.1.1:/tmp/
    ssh root@192.168.1.1 'apk add --allow-untrusted /tmp/luci-app-nlbw-history-1.0.11-r1.apk'

OpenWrt 24.10 and older, `luci-app-nlbw-history_<version>_all.ipk`:

    scp luci-app-nlbw-history_1.0.11-1_all.ipk root@192.168.1.1:/tmp/
    ssh root@192.168.1.1 'opkg install /tmp/luci-app-nlbw-history_1.0.11-1_all.ipk'

**Option B: no package manager.** Copy the source tree to the router and run
`install.sh` on it:

    scp -r luci-app-nlbw-history-src root@192.168.1.1:/tmp/
    ssh root@192.168.1.1 'sh /tmp/luci-app-nlbw-history-src/install.sh'

`install.sh --remove` undoes it.

**Option C: OpenWrt SDK.** Copy `package/luci-app-nlbw-history` into the SDK,
select it in `make menuconfig` under LuCI → Applications, then
`make package/luci-app-nlbw-history/compile V=s`.

Either way, check it came up:

    nlbw-history-collect --status

## Configuration

Everything is editable under **Services → Bandwidth History → Settings**, which
also shows whether the sampler is alive, when it last ran, how much history is
on disk, and which local networks are being counted. Save & Apply reloads the service for you.

The last two options are display only: `auto` leaves the clock and the date
order to whatever browser the page is open in, which is usually right, and the
other values override it for everyone looking at this router.

The same options live in `/etc/config/nlbw-history` if you prefer the shell:

| option | default | meaning |
| --- | --- | --- |
| `period` | `60` | seconds between samples; this is your graph resolution |
| `retention` | `30` | days of history to keep; browsed a month at a time |
| `flush_interval` | `600` | how often the RAM buffer is written to `data_dir` |
| `data_dir` | `/srv/nlbw-history` | where history is stored; **must be persistent** |
| `protocols` | `1` | also record per-protocol traffic |
| `protocol_interval` | `900` | seconds per stored protocol bucket |
| `max_rate` | `10000` | Mbit/s; samples implying more than this are discarded, `0` disables |
| `live_interval` | `3` | seconds per bar on the Live tab; see [Live view](#live-view) |
| `live_window` | `180` | seconds of live history kept in RAM |
| `time_format` | `auto` | clock on the graphs: `auto`, `24` or `12` |
| `date_format` | `auto` | date order on the graphs: `auto`, `dmy` or `mdy` |

    uci set nlbw-history.main.period='30'
    uci commit nlbw-history
    /etc/init.d/nlbw-history reload

Samples are buffered in `/tmp` and written out every `flush_interval`, so the
router touches storage six times an hour rather than once a minute. At most
`flush_interval` seconds of history is lost in a hard power cut; a normal
reboot or service stop flushes first. The LuCI page reads the buffer too, so
recent samples show up immediately.

If you have an NVMe or USB disk mounted, point `data_dir` at it:

    uci set nlbw-history.main.data_dir='/mnt/nvme/nlbw-history'

Expect roughly 5–10 MB per month at `period=60` with 20 busy devices. Only
devices with traffic in an interval get a row, so idle devices cost nothing.

Protocol data is stored separately and aggregated into `protocol_interval`
buckets, because a row per device *per protocol* per sample would be an order
of magnitude more data. At the 15 minute default it costs roughly the same
again as the per-device stream. Protocol graphs can't show detail finer than
that bucket, which the page tells you when a protocol view is on screen. Set
`protocols` to `0` to skip the whole thing.

## Troubleshooting

Work down this list; each step tells you which layer is broken.

**The sampler is not running**

    /etc/init.d/nlbw-history status      # the diagnostic dump
    ps w | grep nlbw-history-loop
    logread -e nlbw-history
    ubus call service list '{"name":"nlbw-history"}'

If procd doesn't know the service at all, the init script isn't executable or
isn't enabled: `chmod +x /etc/init.d/nlbw-history && /etc/init.d/nlbw-history
enable && /etc/init.d/nlbw-history start`.

If it starts and dies, run one sample by hand and read the error:

    sh -x /usr/bin/nlbw-history-collect 2>&1 | tail -30

**nlbwmon returns nothing**

    /etc/init.d/nlbwmon status
    nlbw -c csv -g mac -q -n | head

That must print a header line and then one tab separated row per device. If it
errors, nlbwmon isn't running or its socket is missing, and nothing downstream
can work.

If it runs but a device you expect is missing from that output, the device is
missing from nlbwmon's accounting, not from this package: see
[What gets counted is nlbwmon's decision](#what-gets-counted-is-nlbwmons-decision).

**A bar is impossibly tall**

A single bar claiming more than the link could physically carry is a counter
glitch, not traffic. Hardware flow offloading keeps its own counters and folds
the difference back into conntrack periodically; if that difference is computed
against a reset or reused entry, one bogus jump lands in nlbwmon's totals and
this package records it faithfully.

New samples are checked against `max_rate` and kept out of the graphs. History
recorded before that, or while the ceiling was higher, is checked on demand:

    nlbw-history-collect --scrub             # report, change nothing
    nlbw-history-collect --scrub --apply     # move those rows out

The same check is behind **Check for implausible rows** on the settings page,
which always shows you the report before offering to change anything. Rejected
rows are moved into `<data_dir>/YYYY-MM-DD.suspect.tsv` rather than deleted,
and the graphs then say how many samples are missing and when.

Protocol rows are stored summed per `protocol_interval` bucket, so a single bad
sample cannot be subtracted back out of one. Scrubbing drops the whole bucket
for the affected device, which also loses the legitimate protocol traffic
recorded in it. The per-device figures keep full resolution.

**The LuCI page is missing from the menu**

    ls /www/luci-static/resources/view/nlbw-history/history.js
    ls /usr/share/luci/menu.d/luci-app-nlbw-history.json
    rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache
    /etc/init.d/rpcd restart
    /etc/init.d/uhttpd restart

Then log out of LuCI and back in: the menu and the ACL list are resolved when
your session is created, so a stale session hides a freshly installed page.

**The page is there but empty or erroring**

    ls /usr/lib/rpcd/ucode.so                 # rpcd-mod-ucode installed?
    ubus list | grep luci_nlbw                # backend registered?
    ubus call luci_nlbw_history status '{}'
    ubus call luci_nlbw_history series '{"hours":24}'
    logread -e rpcd

If `ubus list` doesn't show the object, rpcd failed to load the ucode script
and `logread -e rpcd` will say why. If ubus works but the browser doesn't,
open the browser console: a LuCI view that throws leaves the page blank.

The aggregation is also runnable on its own, which is the quickest way to see
whether the problem is the data or the display:

    nlbw-history-query 24 20

Its full argument list is `<hours> [buckets] [mac] [protocol] [end] [hide]`,
where `hide` is the comma separated list of MACs, or of protocol names, that
the graph is leaving out.

## Installed files

    /etc/config/nlbw-history                                 configuration
    /etc/init.d/nlbw-history                                 procd service
    /usr/bin/nlbw-history-loop                               sampling loop
    /usr/bin/nlbw-history-collect                            one sample, flush, status
    /usr/bin/nlbw-history-query                              aggregation into JSON
    /usr/bin/nlbw-history-live                               live view, reads conntrack
    /usr/share/rpcd/ucode/luci.nlbw_history.uc               ubus backend
    /usr/share/rpcd/acl.d/luci-app-nlbw-history.json         ACL
    /usr/share/luci/menu.d/luci-app-nlbw-history.json        menu entry
    /www/luci-static/resources/nlbw-history/chart.js         palette, formatting, the chart
    /www/luci-static/resources/view/nlbw-history/history.js     the history page
    /www/luci-static/resources/view/nlbw-history/live.js     the live page
    /www/luci-static/resources/view/nlbw-history/settings.js the settings page
    <data_dir>/YYYY-MM-DD.tsv                                history: epoch, mac, rx, tx
    <data_dir>/YYYY-MM-DD.proto.tsv                          history: epoch, mac, protocol, rx, tx
    <data_dir>/YYYY-MM-DD.suspect.tsv                        rejected: epoch, mac, rx, tx, elapsed, ceiling

## How this was written

Claude, Anthropic's coding agent, wrote this package: the samplers, the ucode
backend, the LuCI views, the build script and this README. The screenshots
above are the real page rendered against synthetic traffic rather than grabs
from a live router, so the device names and the numbers in them are invented. The maintainer set
the direction, reviewed the result and runs it on the target hardware.

`CLAUDE.md` in the repository root is the context the agent works from. It is
worth a read before changing anything, because it records the busybox, ubus and
LuCI constraints the code is shaped around, and the mistakes already made and
fixed.

None of that changes what you should do before installing a package from a
stranger on a router you care about: read the scripts. They are deliberately
short, and there are only four of them.
