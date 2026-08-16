import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnvService } from '../config/config.service';

import { QdrantService } from './qdrant.service';

const createEnv = (apiKey?: string): EnvService =>
  ({
    qdrantUrl: 'http://qdrant.local:6333',
    qdrantApiKey: apiKey,
    qdrantTimeoutMs: 5_000,
    collectionPrefix: 'processed_item_summary',
  }) as EnvService;

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('QdrantService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('filters search by orgId and sends the API key header', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'GET' || !init?.method) {
        return jsonResponse(200, {
          status: 'ok',
          result: { config: { params: { vectors: { size: 2 } } } },
        });
      }
      if (url.includes('/points/search')) {
        return jsonResponse(200, { status: 'ok', result: [] });
      }
      return jsonResponse(200, { status: 'ok' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = new QdrantService(createEnv('qdrant-secret'));
    await service.search({
      orgId: 'org-42',
      embeddingModel: 'text-embedding-3-small',
      vector: [0.1, 0.2],
      limit: 8,
    });

    const searchCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/points/search'),
    );
    expect(searchCall).toBeDefined();
    const [, searchInit] = searchCall ?? [];
    expect(searchInit?.headers).toMatchObject({
      'content-type': 'application/json',
      'api-key': 'qdrant-secret',
    });
    const body = JSON.parse(String(searchInit?.body)) as {
      filter?: { must?: { key?: string; match?: { value?: string } }[] };
    };
    expect(body.filter?.must).toEqual(
      expect.arrayContaining([{ key: 'orgId', match: { value: 'org-42' } }]),
    );
  });

  it('omits the api-key header when no Qdrant key is configured', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'GET' || !init?.method) {
        return jsonResponse(200, {
          status: 'ok',
          result: { config: { params: { vectors: { size: 2 } } } },
        });
      }
      if (url.includes('/points/search')) {
        return jsonResponse(200, { status: 'ok', result: [] });
      }
      return jsonResponse(200, { status: 'ok' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = new QdrantService(createEnv());
    await service.search({
      orgId: 'org-7',
      embeddingModel: 'text-embedding-3-small',
      vector: [0.4, 0.5],
      limit: 3,
    });

    const searchCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/points/search'),
    );
    const headers = searchCall?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.['api-key']).toBeUndefined();
  });
});
