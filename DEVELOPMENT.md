# Development

Notes for working on luci-app-nlbw-history. See [README.md](README.md) for
installing and configuring it.

## Repository layout

    package/luci-app-nlbw-history/   the OpenWrt package
    build-ipk.sh                     builds the .ipk without an SDK
    install.sh                       installs straight onto a running router
    README.md                        the user-facing document
    CLAUDE.md                        constraints that aren't visible in the code

Read `CLAUDE.md` before changing anything: it records the busybox, ubus and
LuCI constraints that the code is shaped around.

## Building

    ./build-ipk.sh

No OpenWrt SDK needed. The package is shell, ucode and JavaScript only, so
`PKGARCH:=all` and nothing is cross compiled. The version comes from
`PKG_VERSION` and `PKG_RELEASE` in `package/luci-app-nlbw-history/Makefile`,
and the result lands in the repository root as
`luci-app-nlbw-history_<version>-<release>_all.ipk`.

## Testing a change on a router

`install.sh` copies the files in place without going through opkg, which is
the fastest edit-and-try loop:

    scp -r . root@192.168.1.1:/tmp/luci-app-nlbw-history-src
    ssh root@192.168.1.1 'sh /tmp/luci-app-nlbw-history-src/install.sh'

There is no test suite. Off-router, what can be checked is shell and JS syntax
(`sh -n`, `node --check`, which is what CI runs), the collector against a
stubbed `nlbw`, and `nlbw-history-query` against synthetic day files.
`CLAUDE.md` describes both setups.

## Continuous integration

`.github/workflows/build.yml` has two jobs:

- **check** runs on every push and pull request: `sh -n` on the shell scripts,
  `node --check` on the LuCI views, and a JSON parse of the ACL and menu files.
- **package** builds the `.ipk`. It does *not* run on ordinary pushes. It runs
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
3. Sanity check the build with `./build-ipk.sh`.
4. Commit and push to `main`.
5. On GitHub, Releases → Draft a new release. Set the tag to `v<PKG_VERSION>`
   (`v0.5.0` for `PKG_VERSION:=0.5.0`) targeting that commit, write the notes
   from the "What changed" entry, and publish.
6. Publishing triggers the workflow, which builds the `.ipk` and attaches it
   to the release. Check the run finished and the asset is on the release page.

The tag is created by GitHub when the release is published, so there is no
need to tag by hand beforehand.
