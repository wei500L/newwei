export interface ActionRailRouteItem {
  key: string;
  path?: string;
}

export function isPathActive(pathname: string | null, path?: string): boolean {
  if (!pathname || !path) {
    return false;
  }
  return pathname === path || pathname.startsWith(`${path}/`) || pathname.startsWith(`${path}?`);
}

export function resolveActiveItemKey(pathname: string | null, items: readonly ActionRailRouteItem[]): string | null {
  let activeKey: string | null = null;
  let activePathLength = -1;

  for (const item of items) {
    if (!item.path || !isPathActive(pathname, item.path)) {
      continue;
    }
    if (item.path.length > activePathLength) {
      activeKey = item.key;
      activePathLength = item.path.length;
    }
  }

  return activeKey;
}
