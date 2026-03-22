export type AdminSettingsPermission =
  | "settings.manage"
  | "knowledgegraph.review";

export type AdminSettingsPageId =
  | "access"
  | "security"
  | "ingestion"
  | "ai"
  | "knowledge"
  | "news"
  | "editorial"
  | "monitoring"
  | "integrations";

export type AdminSettingsPanelId =
  | "roles"
  | "permissions"
  | "members"
  | "security"
  | "auth-cache"
  | "rate-limits"
  | "rate-limit-policies"
  | "audit-log"
  | "crawl-client"
  | "archive-preparation"
  | "multi-tenant-schedulers"
  | "news-source-scheduler"
  | "news-source-runtime-secrets"
  | "storage"
  | "llm-gateway"
  | "llm-request-logs"
  | "assistant-safety"
  | "vector-service"
  | "model-service"
  | "knowledge-graph"
  | "knowledge-graph-review"
  | "entity-impact-graph"
  | "news-events"
  | "news-event-source-policy"
  | "news-indicator"
  | "news-dedupe"
  | "news-classification"
  | "news-prompts"
  | "newsnow-personalization"
  | "situation-monitor"
  | "realtime-signals"
  | "rss-translation-metrics"
  | "rss-diagnostics"
  | "task-logs"
  | "geo-nominatim"
  | "email"
  | "akshare";

export interface AdminSettingsPanelDefinition {
  id: AdminSettingsPanelId;
  titleKey: string;
  defaultTitle: string;
  defaultDescription: string;
  requiredPermission: AdminSettingsPermission;
}

export interface AdminSettingsPageDefinition {
  id: AdminSettingsPageId;
  titleKey: string;
  defaultTitle: string;
  defaultDescription: string;
  panels: readonly AdminSettingsPanelDefinition[];
}

export interface BuildAdminSettingsHrefOptions {
  page?: AdminSettingsPageId | null;
  panel?: AdminSettingsPanelId | null;
  query?: Record<string, string | number | boolean | null | undefined>;
}

const MANAGE_PERMISSION: AdminSettingsPermission = "settings.manage";
const REVIEW_PERMISSION: AdminSettingsPermission = "knowledgegraph.review";

export const ADMIN_SETTINGS_PAGE_DEFINITIONS: readonly AdminSettingsPageDefinition[] =
  [
    {
      id: "access",
      titleKey: "adminSettings.pages.access.title",
      defaultTitle: "Access Settings",
      defaultDescription:
        "Manage roles, permissions, and organization memberships.",
      panels: [
        {
          id: "roles",
          titleKey: "settings.tabs.roles",
          defaultTitle: "Roles",
          defaultDescription:
            "Define reusable permission bundles for operators and admins.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "permissions",
          titleKey: "settings.tabs.permissions",
          defaultTitle: "Permissions",
          defaultDescription:
            "Inspect the permission catalog available to the workspace.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "members",
          titleKey: "settings.tabs.members",
          defaultTitle: "Members",
          defaultDescription:
            "Assign roles to workspace members and review current access.",
          requiredPermission: MANAGE_PERMISSION,
        },
      ],
    },
    {
      id: "security",
      titleKey: "adminSettings.pages.security.title",
      defaultTitle: "Security & Governance",
      defaultDescription:
        "Tune protections, caches, rate limits, and audit retention.",
      panels: [
        {
          id: "security",
          titleKey: "systemSettings.tabs.security",
          defaultTitle: "Secret encryption",
          defaultDescription:
            "Control secret encryption and validate key health.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "auth-cache",
          titleKey: "settings.tabs.authCache",
          defaultTitle: "Auth cache",
          defaultDescription:
            "Configure profile cache TTLs, lock windows, and retry delays.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "rate-limits",
          titleKey: "settings.tabs.rateLimits",
          defaultTitle: "Rate limits",
          defaultDescription:
            "Throttle sensitive write and authentication flows.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "rate-limit-policies",
          titleKey: "settings.tabs.rateLimitPolicies",
          defaultTitle: "Rate limit policies",
          defaultDescription:
            "Review and edit reusable policy rules for shared rate limits.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "audit-log",
          titleKey: "settings.tabs.auditLog",
          defaultTitle: "Audit logs",
          defaultDescription:
            "Retain security and configuration events for investigations.",
          requiredPermission: MANAGE_PERMISSION,
        },
      ],
    },
    {
      id: "ingestion",
      titleKey: "adminSettings.pages.ingestion.title",
      defaultTitle: "Ingestion & Delivery",
      defaultDescription:
        "Configure crawl clients, scheduler behavior, secrets, and storage.",
      panels: [
        {
          id: "crawl-client",
          titleKey: "settings.tabs.crawlClient",
          defaultTitle: "Crawl client",
          defaultDescription:
            "Tune crawl request, retry, and adaptive concurrency defaults.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "archive-preparation",
          titleKey: "systemSettings.tabs.archivePreparation",
          defaultTitle: "Archive preparation",
          defaultDescription:
            "Configure archive packaging and retention preparation behavior.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "multi-tenant-schedulers",
          titleKey: "systemSettings.tabs.multiTenantSchedulers",
          defaultTitle: "Multi-tenant schedulers",
          defaultDescription:
            "Tune org fan-out concurrency for multi-tenant background cron jobs.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "news-source-scheduler",
          titleKey: "systemSettings.tabs.newsSourceScheduler",
          defaultTitle: "News source scheduler",
          defaultDescription:
            "Tune seed freshness, RSS cadence, and scheduling heuristics.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "news-source-runtime-secrets",
          titleKey: "systemSettings.tabs.newsSourceRuntimeSecrets",
          defaultTitle: "Runtime secrets",
          defaultDescription:
            "Store per-source secrets required by news ingestion providers.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "storage",
          titleKey: "storageSettings.title",
          defaultTitle: "Storage",
          defaultDescription:
            "Configure storage backends and validate object access.",
          requiredPermission: MANAGE_PERMISSION,
        },
      ],
    },
    {
      id: "ai",
      titleKey: "adminSettings.pages.ai.title",
      defaultTitle: "AI Services",
      defaultDescription:
        "Manage gateway routing, safety, and model-adjacent infrastructure.",
      panels: [
        {
          id: "llm-gateway",
          titleKey: "settings.tabs.llmGateway",
          defaultTitle: "LLM gateway",
          defaultDescription:
            "Configure model gateway endpoints, profiles, and governance.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "llm-request-logs",
          titleKey: "settings.tabs.llmRequestLogs",
          defaultTitle: "LLM request logs",
          defaultDescription:
            "Inspect recent gateway requests and debugging traces.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "assistant-safety",
          titleKey: "settings.tabs.assistantSafety",
          defaultTitle: "Assistant safety",
          defaultDescription:
            "Control moderation, guardrails, and safety diagnostics.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "vector-service",
          titleKey: "systemSettings.tabs.vectorService",
          defaultTitle: "Vector service",
          defaultDescription: "Connect and tune the vector retrieval service.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "model-service",
          titleKey: "systemSettings.tabs.modelService",
          defaultTitle: "Model service",
          defaultDescription:
            "Manage internal model service connectivity and credentials.",
          requiredPermission: MANAGE_PERMISSION,
        },
      ],
    },
    {
      id: "knowledge",
      titleKey: "adminSettings.pages.knowledge.title",
      defaultTitle: "Knowledge Systems",
      defaultDescription:
        "Operate knowledge extraction, review, and graph quality settings.",
      panels: [
        {
          id: "knowledge-graph",
          titleKey: "settings.tabs.knowledgeGraph",
          defaultTitle: "Knowledge graph",
          defaultDescription:
            "Tune graph ingestion, thresholds, and extraction behavior.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "knowledge-graph-review",
          titleKey: "settings.tabs.knowledgeGraphReview",
          defaultTitle: "Knowledge graph review",
          defaultDescription:
            "Review low-confidence relations and record human decisions.",
          requiredPermission: REVIEW_PERMISSION,
        },
        {
          id: "entity-impact-graph",
          titleKey: "settings.tabs.entityImpactGraph",
          defaultTitle: "Entity impact graph",
          defaultDescription:
            "Configure graph rendering, force settings, and thresholds.",
          requiredPermission: MANAGE_PERMISSION,
        },
      ],
    },
    {
      id: "news",
      titleKey: "adminSettings.pages.news.title",
      defaultTitle: "News Intelligence",
      defaultDescription:
        "Tune event extraction, indicators, dedupe, and classification.",
      panels: [
        {
          id: "news-events",
          titleKey: "settings.tabs.newsEvents",
          defaultTitle: "News events",
          defaultDescription:
            "Configure event ingestion, scoring, and timeline behavior.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "news-event-source-policy",
          titleKey: "settings.tabs.newsEventSourcePolicy",
          defaultTitle: "Event source policy",
          defaultDescription:
            "Set allowlists, penalties, and source policy behavior.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "news-indicator",
          titleKey: "settings.tabs.newsIndicator",
          defaultTitle: "News indicators",
          defaultDescription:
            "Manage indicator matching, thresholds, and associations.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "news-dedupe",
          titleKey: "settings.tabs.newsDedupe",
          defaultTitle: "News dedupe",
          defaultDescription:
            "Adjust dedupe windows, similarity rules, and fallbacks.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "news-classification",
          titleKey: "settings.tabs.newsClassification",
          defaultTitle: "News classification",
          defaultDescription:
            "Control category routing, model gates, and review defaults.",
          requiredPermission: MANAGE_PERMISSION,
        },
      ],
    },
    {
      id: "editorial",
      titleKey: "adminSettings.pages.editorial.title",
      defaultTitle: "Editorial Controls",
      defaultDescription:
        "Manage newsroom prompts and personalization behavior.",
      panels: [
        {
          id: "news-prompts",
          titleKey: "settings.tabs.newsPrompts",
          defaultTitle: "News prompts",
          defaultDescription:
            "Edit shared prompt templates used across news pipelines.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "newsnow-personalization",
          titleKey: "systemSettings.tabs.newsnowPersonalization",
          defaultTitle: "NewsNow personalization",
          defaultDescription:
            "Tune ranking and personalization behavior for NewsNow.",
          requiredPermission: MANAGE_PERMISSION,
        },
      ],
    },
    {
      id: "monitoring",
      titleKey: "adminSettings.pages.monitoring.title",
      defaultTitle: "Monitoring",
      defaultDescription:
        "Operate live monitoring, realtime signals, and RSS diagnostics.",
      panels: [
        {
          id: "situation-monitor",
          titleKey: "systemSettings.tabs.situationMonitor",
          defaultTitle: "Situation monitor",
          defaultDescription:
            "Configure live monitoring feeds, translation, and Telegram.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "realtime-signals",
          titleKey: "systemSettings.tabs.realtimeSignals",
          defaultTitle: "Realtime signals",
          defaultDescription:
            "Manage signal collectors, providers, and thresholds.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "rss-translation-metrics",
          titleKey: "settings.tabs.rssTranslationMetrics",
          defaultTitle: "RSS translation metrics",
          defaultDescription:
            "Review translation request, cache, and latency metrics.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "rss-diagnostics",
          titleKey: "settings.tabs.rssDiagnostics",
          defaultTitle: "RSS diagnostics",
          defaultDescription:
            "Inspect feed diagnostics and ingest pipeline health.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "task-logs",
          titleKey: "settings.tabs.taskLogs",
          defaultTitle: "Task logs",
          defaultDescription:
            "Manage task-log retention and summary-first observability.",
          requiredPermission: MANAGE_PERMISSION,
        },
      ],
    },
    {
      id: "integrations",
      titleKey: "adminSettings.pages.integrations.title",
      defaultTitle: "Integrations",
      defaultDescription:
        "Manage external service connectivity and infrastructure adapters.",
      panels: [
        {
          id: "geo-nominatim",
          titleKey: "systemSettings.tabs.geoNominatim",
          defaultTitle: "Geo Nominatim",
          defaultDescription:
            "Configure geocoding identification and request testing.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "email",
          titleKey: "systemSettings.tabs.email",
          defaultTitle: "Email",
          defaultDescription:
            "Manage SMTP, test delivery, and auth email code settings.",
          requiredPermission: MANAGE_PERMISSION,
        },
        {
          id: "akshare",
          titleKey: "systemSettings.tabs.akshare",
          defaultTitle: "Akshare",
          defaultDescription:
            "Review Akshare health and manual refresh controls.",
          requiredPermission: MANAGE_PERMISSION,
        },
      ],
    },
  ] as const;

const PAGE_IDS = new Set<AdminSettingsPageId>(
  ADMIN_SETTINGS_PAGE_DEFINITIONS.map((page) => page.id),
);

const PANEL_IDS = new Set<AdminSettingsPanelId>(
  ADMIN_SETTINGS_PAGE_DEFINITIONS.flatMap((page) =>
    page.panels.map((panel) => panel.id),
  ),
);

export function isAdminSettingsPageId(
  value: string,
): value is AdminSettingsPageId {
  return PAGE_IDS.has(value as AdminSettingsPageId);
}

export function isAdminSettingsPanelId(
  value: string,
): value is AdminSettingsPanelId {
  return PANEL_IDS.has(value as AdminSettingsPanelId);
}

export function canManageAdminSettings(
  permissions: readonly string[],
): boolean {
  return permissions.includes(MANAGE_PERMISSION);
}

export function canReviewKnowledgeGraph(
  permissions: readonly string[],
): boolean {
  return (
    permissions.includes(REVIEW_PERMISSION) ||
    permissions.includes(MANAGE_PERMISSION)
  );
}

export function hasAdminSettingsPermission(
  permission: AdminSettingsPermission,
  permissions: readonly string[],
): boolean {
  if (permission === MANAGE_PERMISSION) {
    return canManageAdminSettings(permissions);
  }
  return canReviewKnowledgeGraph(permissions);
}

export function getAdminSettingsPageDefinition(
  pageId: AdminSettingsPageId,
): AdminSettingsPageDefinition {
  const definition = ADMIN_SETTINGS_PAGE_DEFINITIONS.find(
    (page) => page.id === pageId,
  );
  if (!definition) {
    throw new Error(`Unknown admin settings page: ${pageId}`);
  }
  return definition;
}

export function getAdminSettingsPageDescriptionKey(
  pageId: AdminSettingsPageId,
): string {
  return `adminSettings.pages.${pageId}.description`;
}

export function getVisibleAdminSettingsPanels(
  pageId: AdminSettingsPageId,
  permissions: readonly string[],
): AdminSettingsPanelDefinition[] {
  const page = getAdminSettingsPageDefinition(pageId);
  return page.panels.filter((panel) =>
    hasAdminSettingsPermission(panel.requiredPermission, permissions),
  );
}

export function canViewAdminSettingsPage(
  pageId: AdminSettingsPageId,
  permissions: readonly string[],
): boolean {
  return getVisibleAdminSettingsPanels(pageId, permissions).length > 0;
}

export function getVisibleAdminSettingsPages(
  permissions: readonly string[],
): AdminSettingsPageDefinition[] {
  return ADMIN_SETTINGS_PAGE_DEFINITIONS.filter((page) =>
    canViewAdminSettingsPage(page.id, permissions),
  );
}

export function resolveAdminSettingsPagePath(
  pageId?: AdminSettingsPageId | null,
): string {
  return pageId ? `/admin/settings/${pageId}` : "/admin/settings";
}

export function resolveAdminSettingsPageIdFromPathname(
  pathname: string | null,
): AdminSettingsPageId | null {
  if (!pathname || pathname === "/admin/settings") {
    return null;
  }

  const prefix = "/admin/settings/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const value = pathname.slice(prefix.length).split("/")[0]?.trim();
  if (!value || !isAdminSettingsPageId(value)) {
    return null;
  }

  return value;
}

export function buildAdminSettingsHref({
  page,
  panel,
  query,
}: BuildAdminSettingsHrefOptions): string {
  const pathname = resolveAdminSettingsPagePath(page);
  const searchParams = new URLSearchParams();

  if (panel) {
    searchParams.set("panel", panel);
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === false) {
        continue;
      }
      searchParams.set(key, String(value));
    }
  }

  const search = searchParams.toString();
  return search.length > 0 ? `${pathname}?${search}` : pathname;
}

export function resolveVisibleAdminSettingsPanelId(
  candidate: string | null,
  panels: readonly Pick<AdminSettingsPanelDefinition, "id">[],
): AdminSettingsPanelId | null {
  if (!candidate || !isAdminSettingsPanelId(candidate)) {
    return null;
  }

  return panels.some((panel) => panel.id === candidate) ? candidate : null;
}

export {
  buildAdminSettingsPanelSelectionHref,
  getAdminSettingsPanelDescriptionKey,
} from "@/lib/admin-settings-panel-links";
