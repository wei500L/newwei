export interface DrawerNavigationHandlers {
  closeDrawer: () => void;
  push: (path: string) => void;
}

export function navigateDrawerItem(
  path: string | undefined,
  handlers: DrawerNavigationHandlers,
): void {
  if (path) {
    handlers.push(path);
  }
  handlers.closeDrawer();
}
