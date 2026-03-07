import { genSources } from './pre-sources';

describe('news source runtime secret metadata', () => {
  it('exposes runtime secret configuration for sources that support it', () => {
    const sources = genSources();

    expect(sources.producthunt?.runtimeSecrets?.requiredAnyOfKeys).toEqual(
      expect.arrayContaining(['token', 'api_token']),
    );
    expect(sources.producthunt?.runtimeSecrets?.envFallbackKeys).toEqual(
      expect.arrayContaining(['PRODUCTHUNT_API_TOKEN']),
    );

    expect(sources.weibo?.runtimeSecrets?.suggestedKeys).toEqual(
      expect.arrayContaining(['cookie', 'weibo.cookie', 'weibo_cookie']),
    );
    expect(sources.weibo?.runtimeSecrets?.envFallbackKeys).toEqual(
      expect.arrayContaining(['WEIBO_COOKIE']),
    );
  });
});
