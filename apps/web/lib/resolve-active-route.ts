/**
 * 子导航 Tab 的激活项解析：精确匹配优先，否则取「最长前缀」匹配。
 * 修复父路由（如 /dashboard）排在前面时吞掉所有子路由的问题。
 */
export function resolveActiveRouteKey(
  pathname: string | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!pathname || keys.length === 0) {
    return keys[0];
  }
  if (keys.includes(pathname)) {
    return pathname;
  }
  let best: string | undefined;
  for (const key of keys) {
    if (pathname.startsWith(`${key}/`) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  return best ?? keys[0];
}
