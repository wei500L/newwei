import en from "../lib/locales/en.json";

function getDeepValue(object: unknown, pathKey: string): unknown {
  return pathKey.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, object);
}

export function translateTestKey(
  key: string,
  options?: Record<string, unknown>,
): string {
  const value = getDeepValue(en, key);
  const template = typeof value === "string" ? value : key;

  return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => {
    const replacement = options?.[token];
    return replacement == null ? `{{${token}}}` : String(replacement);
  });
}
