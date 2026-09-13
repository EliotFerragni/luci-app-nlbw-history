#!/bin/sh
# Install straight onto a running router, no package manager involved.
# Copy this whole directory to the router and run it there:
#
#   scp -r luci-app-nlbw-history-src root@192.168.1.1:/tmp/
#   ssh root@192.168.1.1 'sh /tmp/luci-app-nlbw-history-src/install.sh'
#
# Uninstall: sh install.sh --remove

set -e

SRC=$(cd "$(dirname "$0")" && pwd)/package/luci-app-nlbw-history/files

# Everything the package ships, as destination paths, read from the files tree
# rather than listed again here, so adding a file needs no change to this
# script. The config file is left out and handled on its own below: it is
# neither overwritten on install nor removed on uninstall.
FILES=$(cd "$SRC" && find . -type f ! -path './etc/config/*' | sed 's|^\.||' | sort)

if [ "$1" = "--remove" ]; then
	/etc/init.d/nlbw-history stop 2>/dev/null || true
	/etc/init.d/nlbw-history disable 2>/dev/null || true
	for f in $FILES; do rm -f "$f"; done
	rm -rf /tmp/nlbw-history /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache
	/etc/init.d/rpcd reload 2>/dev/null || true
	echo "Removed. /etc/config/nlbw-history and the collected history were left in place."
	exit 0
fi

[ -d /etc/init.d ] || { echo "This does not look like an OpenWrt system."; exit 1; }
[ -x /usr/sbin/nlbw ] || echo "Warning: /usr/sbin/nlbw not found - install nlbwmon first."

command -v ucode >/dev/null 2>&1 || [ -f /usr/lib/rpcd/ucode.so ] || \
	echo "Warning: rpcd-mod-ucode does not seem to be installed; the LuCI page will have no backend."

for f in $FILES; do
	mkdir -p "$(dirname "$f")"
	cp "$SRC$f" "$f"
	case "$f" in
		/etc/init.d/*|/usr/bin/*) chmod 0755 "$f" ;;
	esac
done

if [ ! -f /etc/config/nlbw-history ]; then
	cp "$SRC/etc/config/nlbw-history" /etc/config/nlbw-history
	echo "Wrote default config to /etc/config/nlbw-history"
else
	echo "Kept existing /etc/config/nlbw-history"
fi

DATA_DIR=$(uci -q get nlbw-history.main.data_dir || echo /srv/nlbw-history)
mkdir -p "$DATA_DIR"

/etc/init.d/nlbw-history enable
/etc/init.d/nlbw-history restart
/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart
rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache

echo
echo "Installed. Status:"
/usr/bin/nlbw-history-collect --status
echo
echo "The page is under Status -> Bandwidth History."
echo "The first graph appears one sampling interval from now."
