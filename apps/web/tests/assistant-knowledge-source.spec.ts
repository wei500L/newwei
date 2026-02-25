import { describe, expect, it } from 'vitest';

import {
  extractAssistantRequestErrorCodes,
  isAssistantKnowledgeSourceSupported,
  isAssistantWebSearchUnsupportedError,
  normalizeAssistantKnowledgeSource,
} from '../lib/assistant-knowledge-source';

describe('assistant knowledge source helpers', () => {
  it('normalizes unknown value to site_db', () => {
    expect(normalizeAssistantKnowledgeSource(undefined)).toBe('site_db');
    expect(normalizeAssistantKnowledgeSource('anything')).toBe('site_db');
  });

  it('keeps web_search when provided', () => {
    expect(normalizeAssistantKnowledgeSource('web_search')).toBe('web_search');
  });

  it('requires capability for web_search', () => {
    expect(isAssistantKnowledgeSourceSupported('web_search', { webSearchSupported: true })).toBe(true);
    expect(isAssistantKnowledgeSourceSupported('web_search', { webSearchSupported: false })).toBe(false);
    expect(isAssistantKnowledgeSourceSupported('web_search', null)).toBe(false);
  });

  it('always supports site_db', () => {
    expect(isAssistantKnowledgeSourceSupported('site_db', null)).toBe(true);
    expect(isAssistantKnowledgeSourceSupported('site_db', { webSearchSupported: false })).toBe(true);
  });

  it('extracts structured graphql error codes from extensions', () => {
    const error = {
      graphQLErrors: [
        {
          extensions: {
            code: 'BAD_REQUEST',
            originalError: {
              code: 'WEB_SEARCH_UNSUPPORTED',
            },
          },
        },
      ],
    };
    expect(extractAssistantRequestErrorCodes(error)).toEqual(['BAD_REQUEST', 'WEB_SEARCH_UNSUPPORTED']);
    expect(isAssistantWebSearchUnsupportedError(error)).toBe(true);
  });

  it('extracts structured graphql error codes from network result', () => {
    const error = {
      networkError: {
        result: {
          errors: [
            {
              extensions: {
                response: {
                  code: 'WEB_SEARCH_UNSUPPORTED',
                },
              },
            },
          ],
        },
      },
    };
    expect(extractAssistantRequestErrorCodes(error)).toEqual(['WEB_SEARCH_UNSUPPORTED']);
    expect(isAssistantWebSearchUnsupportedError(error)).toBe(true);
  });

  it('returns false when code is absent', () => {
    expect(isAssistantWebSearchUnsupportedError(new Error('WEB_SEARCH_UNSUPPORTED'))).toBe(false);
  });
});
