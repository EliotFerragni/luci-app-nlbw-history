#!/bin/sh
# Build the .apk for OpenWrt 25.12 and newer, which replaced opkg with apk.
# Same package, same files, different container format. Run from the directory
# holding this script.
#
#   ./build-apk.sh  ->  luci-app-nlbw-history-<version>-r<release>.apk
#
# Version, metadata, dependencies, conffiles and the three maintainer scripts
# all come out of the package Makefile, through tools/pkg-meta.sh, exactly as
# they do for the .ipk.
#
# Unlike build-ipk.sh this cannot be done with tar alone: an apk is not an ar
# archive of tarballs but a signed ADB container, and the only thing that
# writes one is `apk mkpkg` from apk-tools 3. That is not the apk on the
# router, which OpenWrt builds with -Dminimal=true and which has no mkpkg, so
# this uses apk-tools from the host if it is there and otherwise borrows one
# from an alpine container. Still no OpenWrt SDK.
#
# The layout and the metadata follow include/package-pack.mk from the OpenWrt
# tree, which is what the SDK would run. Two things in it are easy to miss: the
# file list and the conffile checksums under /lib/apk/packages are part of the
# payload rather than metadata, and the maintainer scripts are not installed
# as-is but wrapped, so that an upgrade and a removal end up on different ones.

set -e

. "$(cd "$(dirname "$0")" && pwd)/tools/pkg-meta.sh"

APKVER="${VERSION}-r${RELEASE}"
OUT="${PKG}-${APKVER}.apk"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

ROOT=$WORK/root
META=$ROOT/lib/apk/packages
SCRIPTS=$WORK/scripts
mkdir -p "$META" "$SCRIPTS"

stage_files "$ROOT"

# The wrappers OpenWrt puts around the package's own scripts. apk splits what
# opkg kept in one script: pre-deinstall runs only on a real removal and
# post-upgrade only on an upgrade, so the "is this an upgrade" question the
# opkg prerm has to ask itself is answered by which script apk chose to run.
sed '/^[[:space:]]*#!/d' > "$SCRIPTS/postinst-body" <<EOF
$(mkdefine postinst)
EOF

{
	echo "#!/bin/sh"
	echo '[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0'
	echo '[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0'
	echo '. ${IPKG_INSTROOT}/lib/functions.sh'
	echo 'export root="${IPKG_INSTROOT}"'
	echo "export pkgname=\"$PKG\""
	echo "add_group_and_user"
	echo "default_postinst"
	cat "$SCRIPTS/postinst-body"
} > "$SCRIPTS/post-install"

{
	echo "#!/bin/sh"
	echo 'export PKG_UPGRADE=1'
	sed '/^[[:space:]]*#!/d' "$SCRIPTS/post-install"
} > "$SCRIPTS/post-upgrade"

# The prerm asks whether $1 is "upgrade" so that it only drops the rc.d symlink
# on a real removal. apk answers that by choosing the script: pre-deinstall is
# the removal, and there is no upgrade equivalent, so the question is already
# settled here and $1 is left unset.
{
	echo "#!/bin/sh"
	echo '[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0'
	echo '. ${IPKG_INSTROOT}/lib/functions.sh'
	echo 'export root="${IPKG_INSTROOT}"'
	echo "export pkgname=\"$PKG\""
	echo "default_prerm"
	mkdefine prerm | sed '/^[[:space:]]*#!/d'
} > "$SCRIPTS/pre-deinstall"

mkdefine postrm > "$SCRIPTS/post-deinstall"

chmod 0755 "$SCRIPTS"/post-install "$SCRIPTS"/post-upgrade \
	"$SCRIPTS"/pre-deinstall "$SCRIPTS"/post-deinstall
rm -f "$SCRIPTS/postinst-body"

# The file list, before the conffile metadata is written, so that it lists the
# package's own files and not the bookkeeping about them. That is the order
# package-pack.mk uses and apk compares the list against what it unpacked.
# OpenWrt does this with find -printf "/%P\n", which strips the leading "./".
# Matching only "^\." would leave that slash in place and write every path with
# a doubled one. busybox find has no -printf, so the sed eats "./" instead.
( cd "$ROOT" && find . \( -type f -o -type l \) | sed 's|^\./|/|' | sort ) > "$WORK/list"
mv "$WORK/list" "$META/$PKG.list"

mkdefine conffiles > "$META/$PKG.conffiles"
: > "$META/$PKG.conffiles_static"
while read -r f; do
	[ -n "$f" ] || continue
	[ -f "$ROOT/$f" ] || continue
	echo "$f $(sha256sum "$ROOT/$f" | cut -d' ' -f1)" >> "$META/$PKG.conffiles_static"
done < "$META/$PKG.conffiles"

set -- \
	--info "name:$PKG" \
	--info "version:$APKVER" \
	--info "description:$(mkvar TITLE)" \
	--info "arch:$([ "$(mkvar PKGARCH)" = all ] && echo noarch || mkvar PKGARCH)" \
	--info "license:$(mkvar PKG_LICENSE)" \
	--info "origin:$PKG" \
	--info "maintainer:$(mkvar PKG_MAINTAINER)" \
	--info "depends:$(mkdepends)" \
	--script "post-install:$SCRIPTS/post-install" \
	--script "post-upgrade:$SCRIPTS/post-upgrade" \
	--script "pre-deinstall:$SCRIPTS/pre-deinstall" \
	--script "post-deinstall:$SCRIPTS/post-deinstall" \
	--files "$ROOT" \
	--output "$WORK/$OUT"

# apk records the owner of every file, so the tree has to be root's. Whichever
# way that is arranged, nothing here needs to run as root itself.
if command -v apk >/dev/null 2>&1 && apk mkpkg --help >/dev/null 2>&1; then
	if [ "$(id -u)" = 0 ]; then
		apk mkpkg "$@"
	elif command -v fakeroot >/dev/null 2>&1; then
		fakeroot apk mkpkg "$@"
	else
		echo "build-apk.sh: apk found but not running as root and no fakeroot;" >&2
		echo "  every file would be owned by $(id -un) instead of root." >&2
		exit 1
	fi
elif command -v docker >/dev/null 2>&1; then
	echo "no apk-tools 3 here, borrowing one from alpine:edge"
	# Handed back afterwards, or the temporary tree stays root's and the
	# cleanup on the way out cannot remove it.
	docker run --rm -u 0:0 -v "$WORK:$WORK" -w "$WORK" alpine:edge \
		sh -c "chown -R 0:0 '$ROOT' && apk mkpkg $(
			for a; do printf " '%s'" "$a"; done
		); _s=\$?; chown -R $(id -u):$(id -g) '$WORK'; exit \$_s"
else
	echo "build-apk.sh: needs apk-tools 3 (for 'apk mkpkg') or docker." >&2
	echo "  The apk on an OpenWrt router is built without mkpkg and cannot do this." >&2
	echo "  See DEVELOPMENT.md for where to get one." >&2
	exit 1
fi

cp "$WORK/$OUT" "$OUT"
echo "built $OUT"
