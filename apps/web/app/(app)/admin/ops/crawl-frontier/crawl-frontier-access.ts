export const CRAWL_FRONTIER_LLM_LOG_PERMISSION = 'settings.manage';

export function canViewCrawlFrontierLlmLogs(
  permissions: readonly string[],
): boolean {
  return permissions.includes(CRAWL_FRONTIER_LLM_LOG_PERMISSION);
}
