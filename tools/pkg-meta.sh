#!/bin/sh
# Sourced by build-ipk.sh and build-apk.sh. Everything either of them needs to
# know about the package is read back out of the package Makefile rather than
# written down a second time, because a second copy is how the two silently
# drift, and the copy that matters is the build script: releases are built with
# those and not with the SDK.
#
# Sourced, not run. $0 is still the build script, so PKG_ROOT resolves relative
# to it and both builders can live at the top of the tree.

PKG=luci-app-nlbw-history
# The top of the tree. $0 is the build script when this is sourced by one;
# anything else that sources it from elsewhere sets this instead.
PKG_ROOT=${PKG_ROOT:-$(cd "$(dirname "$0")" && pwd)}
SRC=$PKG_ROOT/package/$PKG
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

# +luci-base +nlbwmon ... -> luci-base nlbwmon ...
mkdepends() {
	mkvar DEPENDS | sed -e 's/+//g' -e 's/[[:space:]][[:space:]]*/ /g'
}

# The installed tree, staged into $1 with every mode set rather than copied.
# cp -a alone would carry the checkout's own modes into the package, so the
# result depended on the builder's umask, and a checkout that came through a
# transport which drops the exec bit produced a package that could not run.
stage_files() {
	mkdir -p "$1"
	cp -a "$SRC/files/." "$1/"
	find "$1" -type d -exec chmod 0755 {} +
	find "$1" -type f -exec chmod 0644 {} +
	find "$1/etc/init.d" "$1/usr/bin" -type f -exec chmod 0755 {} +
}

VERSION=$(mkvar PKG_VERSION)
RELEASE=$(mkvar PKG_RELEASE)
