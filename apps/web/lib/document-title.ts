/**
 * 浏览器标签页标题的单一入口。
 * 站点名由 providers 按语言设置；页面名由 PageHeader（或个别没有 PageHeader 的页面）设置。
 * 两者谁先谁后都不影响结果，所以不依赖 React effect 的执行顺序。
 */
let siteTitle = "";
let pageTitle: string | null = null;

function apply(): void {
  if (typeof document === "undefined") return;
  if (!siteTitle) return;
  document.title = pageTitle ? `${pageTitle} · ${siteTitle}` : siteTitle;
}

export function setSiteTitle(value: string): void {
  siteTitle = value;
  apply();
}

export function setPageTitle(value: string | null): void {
  pageTitle = value;
  apply();
}
