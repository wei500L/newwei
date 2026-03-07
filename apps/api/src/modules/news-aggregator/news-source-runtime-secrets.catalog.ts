import type { SourceRuntimeSecretsConfig } from './news-aggregator.types';

export const WEIBO_RUNTIME_SECRETS_CONFIG: SourceRuntimeSecretsConfig = {
  description: 'Optional runtime cookie override for Weibo hot search fetching.',
  suggestedKeys: ['cookie', 'weibo.cookie', 'weibo_cookie'],
  envFallbackKeys: ['WEIBO_COOKIE'],
};

export const PRODUCTHUNT_RUNTIME_SECRETS_CONFIG: SourceRuntimeSecretsConfig = {
  description: 'Product Hunt API token for GraphQL hot posts fetching.',
  requiredAnyOfKeys: ['token', 'api_token', 'producthunt.api_token', 'producthunt.token'],
  suggestedKeys: ['token', 'api_token', 'producthunt.api_token', 'producthunt.token'],
  envFallbackKeys: ['PRODUCTHUNT_API_TOKEN'],
};
