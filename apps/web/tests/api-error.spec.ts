import axios from 'axios';
import { describe, expect, it } from 'vitest';

import {
  extractApiError,
  NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE,
} from '../lib/api-error';

describe('api-error extraction', () => {
  it('extracts structured runtime-secret payloads from axios errors', () => {
    const error = new axios.AxiosError(
      'Request failed with status code 424',
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      {
        status: 424,
        statusText: 'Failed Dependency',
        headers: {},
        config: {} as never,
        data: {
          code: NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE,
          message: 'Runtime secret required for news source: producthunt',
          detail: 'Configure at least one runtime secret: token, api_token',
          sourceId: 'producthunt',
          requiredKeys: ['token', 'api_token'],
        },
      } as never,
    );

    expect(extractApiError(error)).toEqual({
      code: NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE,
      message: 'Runtime secret required for news source: producthunt',
      detail: 'Configure at least one runtime secret: token, api_token',
      sourceId: 'producthunt',
      requiredKeys: ['token', 'api_token'],
    });
  });
});
