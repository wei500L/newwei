"use client";

import {
  GlobalOutlined,
  LogoutOutlined,
  MenuOutlined,
  MoonOutlined,
  PlusOutlined,
  SunOutlined,
  SwapOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Button, Drawer, Dropdown, Popover, Skeleton } from "antd";
import type { MenuProps } from "antd";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildActionRailNavConfig } from "./action-rail";
import { resolveActiveItemKey } from "./action-rail-routing";
import {
  alignDensityModeToBase,
  downgradeDensityModeForBase,
  NAV_FULL_MIN_WIDTH,
  NAV_OVERFLOW_EPSILON,
  NAV_UPGRADE_SLACK,
  resolveBaseDensityMode,
  upgradeDensityMode,
  type TopNavDensityMode,
} from "./top-nav-density";

import { captureClientError } from "@/lib/client-telemetry";
import { useTheme } from "@/hooks/use-theme";
import { changeLanguage } from "@/lib/i18n";
import { createTraceHeaders } from "@/lib/trace";

import { AvatarFallback } from "./avatar-fallback";
import { CommandBar } from "./command-bar";
import { LanguageSwitcher } from "./language-switcher";
import { NotificationCenter } from "./notification-center";
import { OrganizationSwitcher } from "./organization-switcher";
import { SystemDefcon } from "./system-defcon";
import { TickerTape } from "./ticker-tape";
import { UserUiSettingsSyncIndicator } from "./user-ui-settings-sync-indicator";

const formatLabel = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

interface TopNavProps {
  showDesktopMenuButton?: boolean;
}

const SSR_SAFE_INITIAL_VIEWPORT_WIDTH = NAV_FULL_MIN_WIDTH;

export function TopNav({ showDesktopMenuButton = false }: TopNavProps) {
  const { t, i18n } = useTranslation();
  const { isDark, toggleTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const [loggingOut, setLoggingOut] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number>(SSR_SAFE_INITIAL_VIEWPORT_WIDTH);
  const [densityMode, setDensityMode] = useState<TopNavDensityMode>(() =>
    resolveBaseDensityMode(SSR_SAFE_INITIAL_VIEWPORT_WIDTH)
  );
  const isLoadingSession = status === "loading";
  const user = session?.user;
  const permissions = session?.permissions ?? user?.permissions ?? [];
  const canStartCrawl = permissions.includes("crawl.write");
  const permissionsKey = useMemo(() => permissions.join("|"), [permissions]);
  const baseDensityMode = useMemo(
    () => resolveBaseDensityMode(viewportWidth),
    [viewportWidth]
  );

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Close drawer when switching to desktop breakpoint unless desktop drawer mode is enabled.
  useEffect(() => {
    if (showDesktopMenuButton) {
      return;
    }
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        setMobileNavOpen(false);
      }
    };
    // Check initial state
    handleChange(mediaQuery);
    // Listen for changes
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [showDesktopMenuButton]);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    setDensityMode((current) => alignDensityModeToBase(current, baseDensityMode));
  }, [baseDensityMode]);

  const checkDensityFit = useCallback(() => {
    const header = headerRef.current;
    if (!header) {
      return;
    }

    const overflow = header.scrollWidth - header.clientWidth;
    if (overflow > NAV_OVERFLOW_EPSILON) {
      setDensityMode((current) => downgradeDensityModeForBase(current, baseDensityMode));
      return;
    }

    const slack = header.clientWidth - header.scrollWidth;
    if (slack >= NAV_UPGRADE_SLACK) {
      setDensityMode((current) => upgradeDensityMode(current, baseDensityMode));
    }
  }, [baseDensityMode]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(checkDensityFit);
    return () => window.cancelAnimationFrame(frameId);
  }, [
    canStartCrawl,
    checkDensityFit,
    densityMode,
    i18n.language,
    isLoadingSession,
    pathname,
    permissionsKey,
    session?.orgId,
  ]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => checkDensityFit());
    observer.observe(header);
    return () => observer.disconnect();
  }, [checkDensityFit]);

  const handleLogout = useCallback(
    async (logoutAll: boolean) => {
      setLoggingOut(true);
      let callbackUrl = "/login";
      try {
        const response = await fetch("/api/logout", {
          method: "POST",
          headers: createTraceHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ logoutAll }),
        });

        if (!response.ok) {
          callbackUrl = "/login?logoutFailed=1";
        }
      } catch (error) {
        captureClientError("Logout error", error);
        callbackUrl = "/login?logoutFailed=1";
      } finally {
        setLoggingOut(false);
      }

      await signOut({ callbackUrl });
    },
    []
  );

  const { mainNavItems, adminNavItems } = useMemo(
    () => buildActionRailNavConfig(t, permissions),
    [permissions, t]
  );
  const allNavItems = useMemo(
    () => [...mainNavItems, ...adminNavItems],
    [adminNavItems, mainNavItems]
  );
  const activeKey = useMemo(
    () => resolveActiveItemKey(pathname, allNavItems),
    [allNavItems, pathname]
  );

  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const displayEmail = user?.email ?? "";
  const displayNameOrEmail = displayName || displayEmail || t("common.notAvailable");
  const avatarSrc = user?.image ?? user?.avatarUrl ?? undefined;
  const planTier = user?.planTier?.trim();
  const subscriptionStatus = user?.subscriptionStatus?.trim();
  const planLabel = planTier ? formatLabel(planTier) : "Free Plan";
  const statusLabel = subscriptionStatus ? formatLabel(subscriptionStatus) : null;
  const planBadgeLabel = statusLabel ? `${planLabel} · ${statusLabel}` : planLabel;
  const startNewCrawlLabel = t("nav.newCrawl", { defaultValue: "New Crawl" });
  const brandShortLabel = t("brand.short", { defaultValue: "M" });
  const brandFullLabel = t("brand.full", { defaultValue: "Modular" });
  const menuButtonClassName = showDesktopMenuButton ? "" : "md:hidden";
  const drawerClassName = showDesktopMenuButton ? "" : "md:hidden";
  const isFullMode = densityMode === "full";
  const isCompactMode = densityMode === "compact";
  const isMinimalMode = densityMode === "minimal";
  const showCommandBar = !isMinimalMode;
  const showSystemDefcon = isFullMode;
  const showPrimaryCrawlButton = canStartCrawl && isFullMode;
  const showCompactCrawlButton = canStartCrawl && isCompactMode;
  const showInlineLanguage = !isMinimalMode;
  const showInlineOrganization = isFullMode;
  const showCompactOrganizationUtility = isCompactMode;
  const showSyncIndicator = !isMinimalMode;
  const showMinimalUtilityButtons = isMinimalMode;
  const commandBarWidthClass = isFullMode ? "max-w-[640px]" : "max-w-[380px]";
  const headerSpacingClassName = isFullMode
    ? "gap-2 border-b border-[var(--border)] px-3 sm:gap-3 sm:px-4 lg:gap-4 lg:px-6"
    : isCompactMode
      ? "gap-2 border-b border-[var(--border)] px-3 sm:gap-2 sm:px-4 lg:gap-3 lg:px-5"
      : "gap-1.5 border-b border-[var(--border)] px-2.5 sm:gap-2 sm:px-3";

  const languageMenuItems: MenuProps["items"] = useMemo(
    () => [
      {
        key: "lang-zh",
        label: t("language.chinese", { defaultValue: "简体中文" }),
        onClick: () => void changeLanguage("zh-CN"),
      },
      {
        key: "lang-en",
        label: t("language.english", { defaultValue: "English" }),
        onClick: () => void changeLanguage("en-US"),
      },
    ],
    [t]
  );

  const userMenuItems: MenuProps["items"] = useMemo(() => {
    const items: MenuProps["items"] = [
      {
        key: "profile-info",
        label: (
          <div className="flex flex-col">
            <span className="font-medium">{displayNameOrEmail}</span>
            <span className="text-xs text-slate-500">{planBadgeLabel}</span>
          </div>
        ),
        disabled: true,
        className: "cursor-default opacity-100 hover:bg-transparent"
      },
      { type: "divider" },
      {
        key: "profile",
        label: t("nav.profile", { defaultValue: "Profile" }),
        icon: <UserOutlined />,
        onClick: () => router.push("/profile")
      }
    ];

    if (canStartCrawl && isMinimalMode) {
      items.push({
        key: "new-crawl",
        label: startNewCrawlLabel,
        icon: <PlusOutlined />,
        onClick: () => router.push("/admin/ops/crawl-tasks?new=true")
      });
    }

    if (isMinimalMode) {
      items.push(
        {
          key: "lang-zh",
          label: t("language.chinese", { defaultValue: "简体中文" }),
          icon: <GlobalOutlined />,
          onClick: () => void changeLanguage("zh-CN"),
        },
        {
          key: "lang-en",
          label: t("language.english", { defaultValue: "English" }),
          icon: <GlobalOutlined />,
          onClick: () => void changeLanguage("en-US"),
        }
      );
    }

    items.push({
      key: "logout",
      label: t("auth.logout"),
      icon: <LogoutOutlined />,
      onClick: () => handleLogout(false),
      disabled: loggingOut
    });

    return items;
  }, [
    canStartCrawl,
    displayNameOrEmail,
    handleLogout,
    isMinimalMode,
    loggingOut,
    planBadgeLabel,
    router,
    startNewCrawlLabel,
    t,
  ]);

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex flex-col">
      {/* Ticker Tape Layer */}
      <TickerTape />

      {/* Main Navbar Layer */}
      <header
        ref={headerRef}
        className={`relative flex h-16 shrink-0 items-center ${headerSpacingClassName} glass`}
      >
        {/* Left: Logo */}
        <div className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-3">
          <Button
            type="text"
            size="large"
            icon={<MenuOutlined className="text-lg" aria-hidden />}
            onClick={() => setMobileNavOpen(true)}
            className={menuButtonClassName}
            aria-label={t("nav.openMenu", { defaultValue: "Open navigation menu" })}
            aria-expanded={mobileNavOpen}
            aria-controls="mobile-navigation-drawer"
          />
          <span className="flex min-w-0 items-center gap-2 whitespace-nowrap font-serif text-lg font-semibold tracking-tight text-[var(--foreground)]">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--primary)]" />
            <span className="sm:hidden">{brandShortLabel}</span>
            <span className="hidden sm:inline">{brandFullLabel}</span>
          </span>
        </div>

        {/* Center: Command Bar (Replaces old nav links) */}
        {showCommandBar ? (
          <div className="hidden min-w-0 flex-1 items-center justify-center px-1 sm:flex md:px-2 lg:px-4">
            <div className={`w-full ${commandBarWidthClass}`}>
              <CommandBar />
            </div>
          </div>
        ) : null}

        {/* Right: Actions + User */}
        <div className="ml-auto flex min-w-0 max-w-full items-center gap-1 sm:gap-2 md:gap-3">
          {showSystemDefcon ? (
            <div className="hidden 2xl:block">
              <SystemDefcon />
            </div>
          ) : null}

          {showSystemDefcon ? (
            <div className="mx-1 hidden h-6 w-px bg-[var(--border)] 2xl:block" />
          ) : null}

          {showPrimaryCrawlButton ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              size="small"
              onClick={() => router.push("/admin/ops/crawl-tasks?new=true")}
              className="hidden shadow-none xl:inline-flex"
            >
              {startNewCrawlLabel}
            </Button>
          ) : null}

          {showCompactCrawlButton ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              size="small"
              onClick={() => router.push("/admin/ops/crawl-tasks?new=true")}
              aria-label={startNewCrawlLabel}
              className="hidden shadow-none xl:inline-flex !px-2"
            />
          ) : null}

          <div className="flex min-w-0 items-center gap-1 sm:gap-2">
            <NotificationCenter />

            {showInlineLanguage ? (
              <div className="hidden lg:block">
                <LanguageSwitcher compact={isCompactMode} />
              </div>
            ) : null}

            {showInlineOrganization ? (
              <div className="hidden xl:block">
                <OrganizationSwitcher
                  mode="full"
                  showErrorText={false}
                />
              </div>
            ) : null}

            {showCompactOrganizationUtility ? (
              <Popover
                trigger="click"
                placement="bottomRight"
                content={
                  <div className="w-[220px]">
                    <OrganizationSwitcher mode="compact" showErrorText={false} />
                  </div>
                }
              >
                <Button
                  type="text"
                  icon={<SwapOutlined />}
                  aria-label={t("orgSwitcher.switch", { defaultValue: "Switch organization" })}
                  className="hidden xl:inline-flex h-8 w-8 items-center justify-center p-0"
                />
              </Popover>
            ) : null}

            {showSyncIndicator ? (
              <div className="hidden xl:block">
                <UserUiSettingsSyncIndicator />
              </div>
            ) : null}

            {showMinimalUtilityButtons ? (
              <>
                <div className="hidden lg:block">
                  <UserUiSettingsSyncIndicator />
                </div>

                <div className="hidden sm:block">
                  <Dropdown
                    menu={{ items: languageMenuItems }}
                    placement="bottomRight"
                    trigger={["click"]}
                  >
                    <Button
                      type="text"
                      icon={<GlobalOutlined />}
                      aria-label={t("language.label", { defaultValue: "Language" })}
                      className="inline-flex h-8 w-8 items-center justify-center p-0"
                    />
                  </Dropdown>
                </div>

                <Popover
                  trigger="click"
                  placement="bottomRight"
                  content={
                    <div className="w-[220px]">
                      <OrganizationSwitcher mode="compact" showErrorText={false} />
                    </div>
                  }
                >
                  <Button
                    type="text"
                    icon={<SwapOutlined />}
                    aria-label={t("orgSwitcher.switch", { defaultValue: "Switch organization" })}
                    className="inline-flex h-8 w-8 items-center justify-center p-0"
                  />
                </Popover>
              </>
            ) : null}
          </div>

          <div className="mx-1 hidden h-6 w-px bg-[var(--border)] lg:block" />

          <Button
            type="text"
            icon={isDark ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggleTheme}
            aria-pressed={isDark}
            aria-label={isDark ? "切换到浅色主题" : "切换到深色主题"}
            title={isDark ? "切换到浅色主题" : "切换到深色主题"}
            className="flex items-center rounded-md !text-[var(--foreground)] opacity-70 transition-opacity hover:opacity-100"
          />

          {isLoadingSession ? (
            <Skeleton.Avatar active size="default" />
          ) : (
              <Dropdown
                  menu={{ items: userMenuItems }}
                  placement="bottomRight"
                  trigger={['click']}
              >
                  <div className="cursor-pointer hover:opacity-80 transition-opacity">
                      <AvatarFallback
                          size="default"
                          src={avatarSrc}
                          name={displayName}
                          email={displayEmail}
                          className="bg-[var(--primary)] text-white border border-[var(--border)] font-bold"
                      />
                  </div>
              </Dropdown>
          )}
        </div>
      </header>

      <Drawer
        id="mobile-navigation-drawer"
        title={t("nav.menu", { defaultValue: "Menu" })}
        placement="left"
        width={320}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        destroyOnHidden
        className={drawerClassName}
      >
        <nav className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            {mainNavItems.map((item) => {
              const isActive = item.key === activeKey;
              return (
                <Link
                  key={item.key}
                  href={item.path ?? "#"}
                  onClick={() => setMobileNavOpen(false)}
                  aria-label={item.label}
                  aria-current={isActive ? "page" : undefined}
                  className={`
                    flex items-center gap-3 rounded-xl px-3 py-2 transition-all duration-200
                    ${isActive
                      ? "bg-[var(--primary)] text-white shadow-sm"
                      : "text-slate-700 hover:text-[var(--primary)] hover:bg-slate-50"
                    }
                  `}
                >
                  <span className="text-lg">{item.icon}</span>
                  <span className="font-medium">{item.label}</span>
                </Link>
              );
            })}
          </div>

          {adminNavItems.length > 0 ? (
            <div className="pt-4 border-t border-[var(--border)] flex flex-col gap-2">
              <span className="px-1 text-[10px] uppercase tracking-[0.2em] text-slate-400">
                {t("nav.adminGroup", { defaultValue: "Admin" })}
              </span>
              <div className="flex flex-col gap-1">
                {adminNavItems.map((item) => {
                  const isActive = item.key === activeKey;
                  return (
                    <Link
                      key={item.key}
                      href={item.path ?? "#"}
                      onClick={() => setMobileNavOpen(false)}
                      aria-label={item.label}
                      aria-current={isActive ? "page" : undefined}
                      className={`
                        flex items-center gap-3 rounded-xl px-3 py-2 transition-all duration-200
                        ${isActive
                          ? "bg-[var(--primary)] text-white shadow-sm"
                          : "text-slate-700 hover:text-[var(--primary)] hover:bg-slate-50"
                        }
                      `}
                    >
                      <span className="text-lg">{item.icon}</span>
                      <span className="font-medium">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ) : null}
        </nav>
      </Drawer>
    </div>
  );
}
