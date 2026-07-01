import type { TFunction } from 'i18next';

interface AccessSettingsRoleLike {
  name: string;
  description?: string | null;
  isSystem: boolean;
}

interface AccessSettingsPermissionLike {
  name: string;
  description?: string | null;
}

interface LocalizedAccessSettingsItem {
  label: string;
  description?: string;
  rawLabel: string;
  rawDescription?: string;
  localized: boolean;
}

type SystemRoleKey = 'admin' | 'manager' | 'analyst';

const SYSTEM_ROLE_TRANSLATION_KEYS: Record<SystemRoleKey, SystemRoleKey> = {
  admin: 'admin',
  manager: 'manager',
  analyst: 'analyst',
};

const CORE_PERMISSION_TRANSLATION_KEYS = {
  'org.read': 'orgRead',
  'org.write': 'orgWrite',
  'settings.manage': 'settingsManage',
  'users.read': 'usersRead',
  'users.write': 'usersWrite',
  'roles.read': 'rolesRead',
  'roles.write': 'rolesWrite',
  'permissions.read': 'permissionsRead',
  'permissions.write': 'permissionsWrite',
  'items.read': 'itemsRead',
  'items.write': 'itemsWrite',
  'dashboards.read': 'dashboardsRead',
  'dashboards.write': 'dashboardsWrite',
  'knowledgegraph.review': 'knowledgegraphReview',
  'alerts.read': 'alertsRead',
  'alerts.manage': 'alertsManage',
  'analysis.read': 'analysisRead',
  'analysis.run': 'analysisRun',
  'assistant.read': 'assistantRead',
  'assistant.run': 'assistantRun',
  'queue.manage': 'queueManage',
  'crawl.read': 'crawlRead',
  'crawl.write': 'crawlWrite',
  'economicdata.read': 'economicdataRead',
  'economicdata.manage': 'economicdataManage',
  'akshare.fetch': 'akshareFetch',
} as const;

function normalizeOptionalText(value?: string | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getSystemRoleTranslationKey(name: string): SystemRoleKey | null {
  const normalized = name.trim().toLowerCase();
  if (normalized in SYSTEM_ROLE_TRANSLATION_KEYS) {
    return normalized as SystemRoleKey;
  }

  return null;
}

function getCorePermissionTranslationKey(name: string): string | null {
  const normalized = name.trim();
  return normalized in CORE_PERMISSION_TRANSLATION_KEYS
    ? CORE_PERMISSION_TRANSLATION_KEYS[
        normalized as keyof typeof CORE_PERMISSION_TRANSLATION_KEYS
      ]
    : null;
}

function resolveLocalizedValue(
  t: TFunction,
  key: string,
  fallback?: string,
): string | undefined {
  const defaultValue = fallback ?? '';
  const resolved = t(key, { defaultValue }).trim();
  return resolved.length > 0 ? resolved : fallback;
}

function compareLocalizedItems(
  left: LocalizedAccessSettingsItem,
  right: LocalizedAccessSettingsItem,
  locale?: string,
): number {
  const labelComparison = left.label.localeCompare(right.label, locale, {
    sensitivity: 'base',
    numeric: true,
  });

  if (labelComparison !== 0) {
    return labelComparison;
  }

  return left.rawLabel.localeCompare(right.rawLabel, locale, {
    sensitivity: 'base',
    numeric: true,
  });
}

export function localizeAccessRole(
  role: AccessSettingsRoleLike,
  t: TFunction,
): LocalizedAccessSettingsItem {
  const rawLabel = role.name;
  const rawDescription = normalizeOptionalText(role.description);

  if (!role.isSystem) {
    return {
      label: rawLabel,
      description: rawDescription,
      rawLabel,
      rawDescription,
      localized: false,
    };
  }

  const translationKey = getSystemRoleTranslationKey(role.name);
  if (!translationKey) {
    return {
      label: rawLabel,
      description: rawDescription,
      rawLabel,
      rawDescription,
      localized: false,
    };
  }

  return {
    label:
      resolveLocalizedValue(
        t,
        `settings.rbac.roles.${translationKey}.label`,
        rawLabel,
      ) ?? rawLabel,
    description: resolveLocalizedValue(
      t,
      `settings.rbac.roles.${translationKey}.description`,
      rawDescription,
    ),
    rawLabel,
    rawDescription,
    localized: true,
  };
}

export function localizeAccessPermission(
  permission: AccessSettingsPermissionLike,
  t: TFunction,
): LocalizedAccessSettingsItem {
  const rawLabel = permission.name;
  const rawDescription = normalizeOptionalText(permission.description);
  const translationKey = getCorePermissionTranslationKey(permission.name);

  if (!translationKey) {
    return {
      label: rawLabel,
      description: rawDescription,
      rawLabel,
      rawDescription,
      localized: false,
    };
  }

  return {
    label:
      resolveLocalizedValue(
        t,
        `settings.rbac.permissions.${translationKey}.label`,
        rawLabel,
      ) ?? rawLabel,
    description: resolveLocalizedValue(
      t,
      `settings.rbac.permissions.${translationKey}.description`,
      rawDescription,
    ),
    rawLabel,
    rawDescription,
    localized: true,
  };
}

export function formatAccessRoleOptionLabel(
  role: AccessSettingsRoleLike,
  t: TFunction,
): string {
  const localized = localizeAccessRole(role, t);
  return localized.localized &&
    localized.label.trim().toLowerCase() !==
      localized.rawLabel.trim().toLowerCase()
    ? `${localized.label} (${localized.rawLabel})`
    : localized.label;
}

export function formatAccessPermissionOptionLabel(
  permission: AccessSettingsPermissionLike,
  t: TFunction,
): string {
  const localized = localizeAccessPermission(permission, t);
  return localized.localized && localized.label !== localized.rawLabel
    ? `${localized.label} (${localized.rawLabel})`
    : localized.label;
}

export function compareAccessRoleLabels(
  left: AccessSettingsRoleLike,
  right: AccessSettingsRoleLike,
  t: TFunction,
  locale?: string,
): number {
  return compareLocalizedItems(
    localizeAccessRole(left, t),
    localizeAccessRole(right, t),
    locale,
  );
}

export function compareAccessPermissionLabels(
  left: AccessSettingsPermissionLike,
  right: AccessSettingsPermissionLike,
  t: TFunction,
  locale?: string,
): number {
  return compareLocalizedItems(
    localizeAccessPermission(left, t),
    localizeAccessPermission(right, t),
    locale,
  );
}

export function getCorePermissionTranslationEntries(): {
  name: keyof typeof CORE_PERMISSION_TRANSLATION_KEYS;
  key: (typeof CORE_PERMISSION_TRANSLATION_KEYS)[keyof typeof CORE_PERMISSION_TRANSLATION_KEYS];
}[] {
  return Object.entries(CORE_PERMISSION_TRANSLATION_KEYS).map(([name, key]) => ({
    name: name as keyof typeof CORE_PERMISSION_TRANSLATION_KEYS,
    key,
  }));
}

export function getSystemRoleTranslationEntries(): {
  name: SystemRoleKey;
  key: SystemRoleKey;
}[] {
  return Object.entries(SYSTEM_ROLE_TRANSLATION_KEYS).map(([name, key]) => ({
    name: name as SystemRoleKey,
    key,
  }));
}
