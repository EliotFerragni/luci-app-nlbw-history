include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-nlbw-history
PKG_VERSION:=1.0.2
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Local build

include $(INCLUDE_DIR)/package.mk

# Shell, ucode and LuCI JavaScript only, so the package fits any target.
PKGARCH:=all

define Package/luci-app-nlbw-history
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Historical per-device bandwidth graphs from nlbwmon
  DEPENDS:=+luci-base +nlbwmon +rpcd-mod-ucode
endef

define Package/luci-app-nlbw-history/description
 Samples nlbwmon's per-MAC cumulative counters on a timer and stores the
 deltas, giving per-device bandwidth graphs over time in LuCI. It only reads
 nlbwmon's counters: no packet inspection, no firewall rules and no effect on
 software or hardware flow offloading.
endef

define Package/luci-app-nlbw-history/conffiles
/etc/config/nlbw-history
endef

# Nothing to build. Without these two lines the default rule runs make in an
# empty build directory and the package fails to compile.
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/luci-app-nlbw-history/install
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/nlbw-history $(1)/etc/config/nlbw-history
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/nlbw-history $(1)/etc/init.d/nlbw-history
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/nlbw-history-collect $(1)/usr/bin/nlbw-history-collect
	$(INSTALL_BIN) ./files/usr/bin/nlbw-history-loop $(1)/usr/bin/nlbw-history-loop
	$(INSTALL_BIN) ./files/usr/bin/nlbw-history-query $(1)/usr/bin/nlbw-history-query
	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DATA) ./files/usr/share/rpcd/ucode/luci.nlbw_history.uc $(1)/usr/share/rpcd/ucode/luci.nlbw_history.uc
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-app-nlbw-history.json $(1)/usr/share/rpcd/acl.d/luci-app-nlbw-history.json
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/usr/share/luci/menu.d/luci-app-nlbw-history.json $(1)/usr/share/luci/menu.d/luci-app-nlbw-history.json
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/nlbw-history
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/nlbw-history/main.js $(1)/www/luci-static/resources/view/nlbw-history/main.js
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/nlbw-history/settings.js $(1)/www/luci-static/resources/view/nlbw-history/settings.js
endef

define Package/luci-app-nlbw-history/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/nlbw-history enable
# A bare start is not enough: procd compares the instance definition and does
# nothing when it is unchanged, which it always is here, so the old
# nlbw-history-loop would keep running from the replaced inode. Not restart
# either, because its stop asks procd to delete a service that is not
# registered at this point (prerm stopped it on an upgrade, and on a first
# install it never ran) and ubus reports that as a command failure. Only the
# stop is silenced: a start that fails is still worth seeing.
/etc/init.d/nlbw-history stop >/dev/null 2>&1
/etc/init.d/nlbw-history start
/etc/init.d/rpcd reload >/dev/null 2>&1
# LuCI caches the menu and the module index; both have to go or the new entry
# will not show up until something else invalidates them.
rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache
exit 0
endef

define Package/luci-app-nlbw-history/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/nlbw-history stop >/dev/null 2>&1
# opkg passes "upgrade" when a newer version is replacing this one, and only a
# real removal should drop the rc.d symlink. Disabling on upgrade leaves the
# service off permanently if the install dies before the new postinst runs.
[ "$$1" = "upgrade" ] || /etc/init.d/nlbw-history disable >/dev/null 2>&1
exit 0
endef

define Package/luci-app-nlbw-history/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
rm -rf /tmp/nlbw-history
rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache
/etc/init.d/rpcd reload >/dev/null 2>&1
# Collected history under data_dir is deliberately left in place.
exit 0
endef

$(eval $(call BuildPackage,luci-app-nlbw-history))
