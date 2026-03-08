import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionMock = vi.fn();

vi.mock('next-auth/react', () => ({
  getSession: getSessionMock,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

describe('api-client session cache', () => {
  beforeEach(async () => {
    vi.stubGlobal('window', {});
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://example.com';
    getSessionMock.mockReset();

    const { invalidateApiSessionCache } = await import('../lib/api-client');
    invalidateApiSessionCache();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    getSessionMock.mockReset();

    const { invalidateApiSessionCache } = await import('../lib/api-client');
    invalidateApiSessionCache();
  });

  it('does not let a stale in-flight session fetch overwrite a refreshed cache', async () => {
    const { getCachedApiSession, syncApiSessionCache } = await import('../lib/api-client');
    const staleSession = createDeferred<Record<string, unknown> | null>();

    getSessionMock.mockReturnValueOnce(staleSession.promise);
    const staleResultPromise = getCachedApiSession();

    getSessionMock.mockResolvedValueOnce({ accessToken: 'fresh-token' });
    const freshSession = await syncApiSessionCache();

    staleSession.resolve(null);

    expect(freshSession).toEqual({ accessToken: 'fresh-token' });
    expect(await staleResultPromise).toBeNull();
    expect(await getCachedApiSession()).toEqual({ accessToken: 'fresh-token' });
  });
});
