# Development

Notes for working on luci-app-nlbw-history. See [README.md](README.md) for
installing and configuring it.

## Repository layout

    package/luci-app-nlbw-history/   the OpenWrt package
    build-ipk.sh                     builds the .ipk without an SDK (24.10 and older)
    build-apk.sh                     builds the .apk without an SDK (25.12 and newer)
    tools/pkg-meta.sh                what both builders read out of the package Makefile
    install.sh                       installs straight onto a running router
    README.md                        the user-facing document
    CLAUDE.md                        constraints that aren't visible in the code

Read `CLAUDE.md` before changing anything: it records the busybox, ubus and
LuCI constraints that the code is shaped around.

## Building

    ./build-ipk.sh    OpenWrt 24.10 and older, -> luci-app-nlbw-history_<version>-<release>_all.ipk
    ./build-apk.sh    OpenWrt 25.12 and newer, -> luci-app-nlbw-history-<version>-r<release>.apk

**`build-apk.sh` needs docker**, unless you have apk-tools 3 on the machine,
which almost nobody does. It runs one `docker run --rm` against `alpine:edge`,
pulling that image the first time: 8 MB, and the only thing either builder
leaves on the machine. `docker rmi alpine:edge` takes it back. `build-ipk.sh`
needs nothing but `tar`.

No OpenWrt SDK needed for either. The package is shell, ucode and JavaScript
only, so `PKGARCH:=all` and nothing is cross compiled. Both read the version,
the metadata, the dependencies, the conffiles and all three maintainer scripts
out of `package/luci-app-nlbw-history/Makefile` through `tools/pkg-meta.sh`, so
there is one copy of each and the two builders cannot drift apart.

The `.ipk` is an ar archive of tarballs and `tar` is all it takes. The `.apk`
is not: it is a signed ADB container, and the only thing that writes one is
`apk mkpkg` from apk-tools 3. Note that this is **not** the `apk` on the
router, which OpenWrt builds with `-Dminimal=true` and which has no `mkpkg`.
`build-apk.sh` uses apk-tools from the host when it finds one, and otherwise
runs `apk mkpkg` in an `alpine:edge` container. So either install apk-tools 3
or have docker; the script stops and says so when it finds neither.

The container runs as root and chowns the staged tree, then hands it back to
the calling user before it exits. Without that last part the temporary
directory stays root-owned and the cleanup on the way out cannot remove it.
apk records the owner of every file, so the staged tree has to be root's;
running as root or having `fakeroot` covers that on the host.

What the `.apk` contains follows `include/package-pack.mk` from the OpenWrt
tree, which is what the SDK would run. Two parts of it are easy to miss:

- the file list and the conffile checksums under `/lib/apk/packages` are part
  of the package payload rather than its metadata, and the list is generated
  before the conffile bookkeeping so that it does not describe itself;
- the maintainer scripts are not shipped as written. apk splits what opkg kept
  in one script, so `postinst` is wrapped into both `post-install` and
  `post-upgrade`, and `prerm` becomes `pre-deinstall`, which apk runs **only**
  on a real removal. That is why `prerm` can ask opkg whether this is an
  upgrade and still be right under apk: the token `upgrade` is never passed
  there, so the `disable` it guards runs exactly when the package is removed.
  An apk upgrade runs `post-upgrade` alone, so the `stop` in `postinst` is what
  replaces the running service there.

## Testing a change on a router

`install.sh` copies the files in place without going through a package manager
at all, which is the fastest edit-and-try loop and works the same on every
release:

    scp -r . root@192.168.1.1:/tmp/luci-app-nlbw-history-src
    ssh root@192.168.1.1 'sh /tmp/luci-app-nlbw-history-src/install.sh'

There is no test suite. Off-router, what can be checked is shell and JS syntax
(`sh -n`, `node --check`, which is what CI runs), the collector against a
stubbed `nlbw`, and `nlbw-history-query` against synthetic day files.
`CLAUDE.md` describes both setups.

## Running the view without a router

    python3 tools/preview.py

That puts the LuCI page on `http://127.0.0.1:8099` and is the fastest way to
work on `main.js`. It writes synthetic history in the format the sampler
stores, and answers the page's rpc calls by running the real
`nlbw-history-query` against it, so the device, protocol and period filters
behave as they do on a router. Nothing about the page is reimplemented: the
view file runs as-is behind stubs shaped like LuCI's `E`, `rpc`, `uci`, `view`
and `poll`.

`--days N` decides how much history there is to look at, `--port N` moves it,
`--time-format` and `--date-format` say what the page is told those settings
are, and `?device=&protocol=&period=` on the URL preselects a state worth
returning to. The page reports what it drew, and anything it throws, to the
terminal, which saves opening devtools.

The README images come from the same script:

    python3 tools/preview.py --screenshots

which writes `docs/*.png` through headless Firefox instead of serving. An image
that stops matching the code means the code moved.

Needs `python3-pil`, and `firefox` for `--screenshots`; it uses `busybox` for
awk and date when installed. Every window ends at the current time, so each run
shifts the clock labels: regenerate the images when the page changed, not out
of habit.

## Continuous integration

`.github/workflows/build.yml` has two jobs:

- **check** runs on every push and pull request: `sh -n` on the shell scripts,
  `node --check` on the LuCI views, and a JSON parse of the ACL and menu files.
- **package** builds the `.ipk` and the `.apk`. It does *not* run on ordinary
  pushes. It runs
  only when the workflow is started by hand (Actions → build → Run workflow),
  where the `.ipk` is a run artifact kept for 3 days, and when a GitHub release
  is published, where the `.ipk` is uploaded to that release.

Pushing a tag on its own builds nothing, and a release left as a draft
publishes nothing: the upload happens at the moment the release is published.

## Release procedure

1. Bump `PKG_VERSION` in `package/luci-app-nlbw-history/Makefile` and reset
   `PKG_RELEASE` to `1`. Bump `PKG_RELEASE` alone when only the packaging
   changed and no installed file did.
2. Update the README: the version in the title and the filename in the install
   commands.
3. Sanity check both builds with `./build-ipk.sh` and `./build-apk.sh`.
4. Commit and push to `main`.
5. On GitHub, Releases → Draft a new release. Set the tag to `v<PKG_VERSION>`
   (`v1.2.3` for `PKG_VERSION:=1.2.3`) targeting that commit, write the notes
   describing what changed, and publish. The release notes are the changelog;
   the repository does not keep one.
6. Publishing triggers the workflow, which builds the `.ipk` and the `.apk`
   and attaches both. Check the run finished and both assets are on the
   release page.

The tag is created by GitHub when the release is published, so there is no
need to tag by hand beforehand.
