import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.fn();
const getCachedApiSessionMock = vi.fn();

vi.mock('../lib/api-client', () => ({
  createApiClient: () => ({
    post: postMock,
  }),
  getCachedApiSession: getCachedApiSessionMock,
}));

describe('user news behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
      share: vi.fn().mockResolvedValue(undefined),
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    postMock.mockReset();
    getCachedApiSessionMock.mockReset();
    getCachedApiSessionMock.mockResolvedValue({
      accessToken: 'test-token',
      permissions: ['items.read'],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the original article URL when recording share behavior', async () => {
    const { shareTrackedNewsLink } = await import('../lib/user-news-behavior');

    await shareTrackedNewsLink({
      title: 'Story',
      url: 'https://app.example/items/123',
      behavior: {
        type: 'share',
        source: 'Reuters',
        url: 'https://publisher.example/story',
      },
    });

    expect(postMock).toHaveBeenCalledWith(
      '/user-news-behavior',
      expect.objectContaining({
        type: 'share',
        source: 'Reuters',
        url: 'https://publisher.example/story',
      }),
    );
  });
});
