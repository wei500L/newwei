export function getAdminSettingsPanelDescriptionKey(panelId: string): string {
  return `adminSettings.panels.${panelId}.description`;
}

export function buildAdminSettingsPanelSelectionHref(
  pathname: string,
  search: string | { toString(): string },
  panelId: string,
): string {
  const next = new URLSearchParams(
    typeof search === "string" ? search : search.toString(),
  );
  next.set("panel", panelId);
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}
