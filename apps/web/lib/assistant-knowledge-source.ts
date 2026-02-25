export type AssistantKnowledgeSource = 'site_db' | 'web_search';
export const WEB_SEARCH_UNSUPPORTED_ERROR_CODE = 'WEB_SEARCH_UNSUPPORTED';

export interface AssistantRuntimeCapabilitiesLike {
  webSearchSupported?: boolean | null;
}

export const DEFAULT_ASSISTANT_KNOWLEDGE_SOURCE: AssistantKnowledgeSource = 'site_db';

export function normalizeAssistantKnowledgeSource(value: unknown): AssistantKnowledgeSource {
  if (value === 'web_search') {
    return 'web_search';
  }
  return DEFAULT_ASSISTANT_KNOWLEDGE_SOURCE;
}

export function isAssistantKnowledgeSourceSupported(
  source: AssistantKnowledgeSource,
  capabilities?: AssistantRuntimeCapabilitiesLike | null,
): boolean {
  if (source === 'web_search') {
    return capabilities?.webSearchSupported === true;
  }
  return true;
}

const CODE_KEYS = new Set(['code', 'appCode']);
const NESTED_KEYS = new Set([
  'graphQLErrors',
  'networkError',
  'extensions',
  'originalError',
  'response',
  'exception',
  'result',
  'errors',
  'message',
]);
const MAX_CODE_SCAN_DEPTH = 7;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const normalizeCode = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
};

const collectCodes = (value: unknown, result: Set<string>, depth = 0): void => {
  if (depth > MAX_CODE_SCAN_DEPTH || value == null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectCodes(entry, result, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (CODE_KEYS.has(key)) {
      const code = normalizeCode(nested);
      if (code) {
        result.add(code);
      }
    }
    if (NESTED_KEYS.has(key)) {
      collectCodes(nested, result, depth + 1);
    }
  }
};

export function extractAssistantRequestErrorCodes(error: unknown): string[] {
  const codes = new Set<string>();
  collectCodes(error, codes);
  return Array.from(codes);
}

export function isAssistantWebSearchUnsupportedError(error: unknown): boolean {
  return extractAssistantRequestErrorCodes(error).includes(WEB_SEARCH_UNSUPPORTED_ERROR_CODE);
}
