#!/bin/sh
# Build the .ipk without an OpenWrt SDK. The package contains only shell,
# ucode and JavaScript, so nothing needs cross compiling. Run on any Linux
# box (or on the router itself) from the directory holding this script.
#
#   ./build-ipk.sh  ->  luci-app-nlbw-history_<version>_all.ipk
#
# Everything that the package Makefile also states is read back out of it:
# version, metadata, dependencies, conffiles and the three maintainer scripts.
# Keeping a second copy here is how the two silently drift, and the copy that
# matters is this one, since releases are built with this script and not with
# the SDK.

set -e

PKG=luci-app-nlbw-history
SRC=$(cd "$(dirname "$0")" && pwd)/package/$PKG
MK="$SRC/Makefile"

# A plain `NAME:=value' from the Makefile, indented or not.
mkvar() {
	sed -n "s/^[[:space:]]*$1:=[[:space:]]*//p" "$MK" | head -n1
}

# The body of a `define Package/<pkg>/<name>' block. OpenWrt writes these out
# after make has expanded them, which turns every $$ back into a single $, so
# do the same here. Nothing in these blocks uses the $(...) forms, which this
# deliberately does not try to handle.
mkdefine() {
	sed -n "/^define Package\/$PKG\/$1\$/,/^endef\$/p" "$MK" |
		sed -e '1d' -e '$d' -e 's/\$\$/$/g'
}

VERSION=$(mkvar PKG_VERSION)
RELEASE=$(mkvar PKG_RELEASE)
OUT="${PKG}_${VERSION}-${RELEASE}_all.ipk"

# +luci-base +nlbwmon ... -> luci-base, nlbwmon, ...
DEPENDS=$(mkvar DEPENDS | sed -e 's/+//g' -e 's/[[:space:]][[:space:]]*/, /g')

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/control"

cp -a "$SRC/files/." "$WORK/data/"

# The exec bits are right in git, but a checkout that came through a transport
# which drops them would otherwise produce an unusable package.
find "$WORK/data/etc/init.d" "$WORK/data/usr/bin" -type f -exec chmod 0755 {} +

# du -sb is GNU only. The || cannot go on the pipeline, because a pipeline
# reports cut's status and not du's, which silently left this field empty.
SIZE=$(du -sb "$WORK/data" 2>/dev/null | cut -f1)
[ -n "$SIZE" ] || SIZE=$(( $(du -sk "$WORK/data" | cut -f1) * 1024 ))

cat > "$WORK/control/control" <<EOF
Package: $PKG
Version: ${VERSION}-${RELEASE}
Depends: $DEPENDS
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
