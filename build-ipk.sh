#!/bin/sh
# Build the .ipk for OpenWrt 24.10 and older, without an OpenWrt SDK. The
# package contains only shell, ucode and JavaScript, so nothing needs cross
# compiling. Run on any Linux box (or on the router itself) from the directory
# holding this script.
#
#   ./build-ipk.sh  ->  luci-app-nlbw-history_<version>_all.ipk
#
# OpenWrt 25.12 replaced opkg with apk and cannot install this; build-apk.sh
# produces the package for those.
#
# Version, metadata, dependencies, conffiles and the three maintainer scripts
# all come out of the package Makefile, through tools/pkg-meta.sh.

set -e

. "$(cd "$(dirname "$0")" && pwd)/tools/pkg-meta.sh"

OUT="${PKG}_${VERSION}-${RELEASE}_all.ipk"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/control"

stage_files "$WORK/data"

# du -sb is GNU only. The || cannot go on the pipeline, because a pipeline
# reports cut's status and not du's, which silently left this field empty.
SIZE=$(du -sb "$WORK/data" 2>/dev/null | cut -f1)
[ -n "$SIZE" ] || SIZE=$(( $(du -sk "$WORK/data" | cut -f1) * 1024 ))

cat > "$WORK/control/control" <<EOF
Package: $PKG
Version: ${VERSION}-${RELEASE}
Depends: $(mkdepends | sed 's/ /, /g')
Section: $(mkvar SECTION)
Architecture: $(mkvar PKGARCH)
Installed-Size: ${SIZE}
Maintainer: $(mkvar PKG_MAINTAINER)
License: $(mkvar PKG_LICENSE)
Description: $(mkvar TITLE)
$(mkdefine description)
EOF

mkdefine conffiles > "$WORK/control/conffiles"

for script in postinst prerm postrm; do
	mkdefine "$script" > "$WORK/control/$script"
	chmod 0755 "$WORK/control/$script"
done

( cd "$WORK/data" && tar --numeric-owner --owner=0 --group=0 -czf ../data.tar.gz ./* )
( cd "$WORK/control" && tar --numeric-owner --owner=0 --group=0 -czf ../control.tar.gz ./* )
echo "2.0" > "$WORK/debian-binary"

( cd "$WORK" && tar --numeric-owner --owner=0 --group=0 -czf package.tar.gz \
	./debian-binary ./data.tar.gz ./control.tar.gz )

cp "$WORK/package.tar.gz" "$OUT"
echo "built $OUT"
