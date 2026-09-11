#!/bin/sh
# Build the .ipk without an OpenWrt SDK. The package contains only shell,
# ucode and JavaScript, so nothing needs cross compiling. Run on any Linux
# box (or on the router itself) from the directory holding this script.
#
#   ./build-ipk.sh  ->  luci-app-nlbw-history_<version>_all.ipk

set -e

SRC=$(cd "$(dirname "$0")" && pwd)/package/luci-app-nlbw-history
VERSION=$(sed -n 's/^PKG_VERSION:=//p' "$SRC/Makefile")
RELEASE=$(sed -n 's/^PKG_RELEASE:=//p' "$SRC/Makefile")
OUT="luci-app-nlbw-history_${VERSION}-${RELEASE}_all.ipk"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/control"

cp -a "$SRC/files/." "$WORK/data/"
chmod 0755 "$WORK/data/etc/init.d/nlbw-history" \
           "$WORK/data/usr/bin/nlbw-history-collect" \
           "$WORK/data/usr/bin/nlbw-history-loop" \
           "$WORK/data/usr/bin/nlbw-history-query"

SIZE=$(du -sb "$WORK/data" 2>/dev/null | cut -f1 || du -sk "$WORK/data" | cut -f1)

cat > "$WORK/control/control" <<EOF
Package: luci-app-nlbw-history
Version: ${VERSION}-${RELEASE}
Depends: luci-base, nlbwmon, rpcd-mod-ucode
Section: luci
Architecture: all
Installed-Size: ${SIZE}
Maintainer: Local build
License: Apache-2.0
Description: Historical per-device bandwidth graphs from nlbwmon.
 Samples nlbwmon's per-MAC counters on a timer and stores the deltas, giving
 per-device bandwidth graphs over time in LuCI. Reads nlbwmon's counters only:
 no packet inspection and no effect on flow offloading.
EOF

echo "/etc/config/nlbw-history" > "$WORK/control/conffiles"

cat > "$WORK/control/postinst" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/nlbw-history enable
/etc/init.d/nlbw-history start
/etc/init.d/rpcd reload >/dev/null 2>&1
rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache
exit 0
EOF

cat > "$WORK/control/prerm" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/nlbw-history stop >/dev/null 2>&1
/etc/init.d/nlbw-history disable >/dev/null 2>&1
exit 0
EOF

cat > "$WORK/control/postrm" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
rm -rf /tmp/nlbw-history
rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache
/etc/init.d/rpcd reload >/dev/null 2>&1
exit 0
EOF

chmod 0755 "$WORK/control/postinst" "$WORK/control/prerm" "$WORK/control/postrm"

( cd "$WORK/data" && tar --numeric-owner --owner=0 --group=0 -czf ../data.tar.gz ./* )
( cd "$WORK/control" && tar --numeric-owner --owner=0 --group=0 -czf ../control.tar.gz ./* )
echo "2.0" > "$WORK/debian-binary"

( cd "$WORK" && tar --numeric-owner --owner=0 --group=0 -czf package.tar.gz \
	./debian-binary ./data.tar.gz ./control.tar.gz )

cp "$WORK/package.tar.gz" "$OUT"
echo "built $OUT"
