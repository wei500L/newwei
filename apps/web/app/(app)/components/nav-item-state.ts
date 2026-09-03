/**
 * 导航项交互状态类（ActionRail 与移动 Drawer 共用，FE-批2）。
 *
 * 状态样式（active / hover / focus）由 globals.css 的「App Shell 导航」
 * token 段落定义（.nav-item--*）；这里只做 active 与强调级别的映射，
 * 避免 rail 与 drawer 两套状态类各自漂移。
 *
 * 强调级别：rail 图标用 default（次级图标色），drawer 行文字用 strong
 * （正文对比度，见 design-system.md 暗色与对比度规则）。
 */
export type NavItemEmphasis = "default" | "strong";

export function navItemStateClass(
  active: boolean,
  emphasis: NavItemEmphasis = "default",
): string {
  if (active) {
    return "nav-item--active";
  }
  return emphasis === "strong" ? "nav-item--idle-strong" : "nav-item--idle";
}
