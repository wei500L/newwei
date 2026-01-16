import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { VectorEnv } from './env.schema';

@Injectable()
export class EnvService {
  constructor(private readonly config: ConfigService<VectorEnv, true>) {}

  get port(): number {
    return this.config.get('PORT', { infer: true });
  }

  get internalToken(): string {
    return this.config.get('VECTOR_INTERNAL_TOKEN', { infer: true });
  }

  get qdrantUrl(): string {
    return this.config.get('QDRANT_URL', { infer: true });
  }

  get qdrantApiKey(): string | undefined {
    return this.config.get('QDRANT_API_KEY', { infer: true });
  }

  get qdrantTimeoutMs(): number {
    return this.config.get('VECTOR_QDRANT_TIMEOUT_MS', { infer: true });
  }

  get collectionPrefix(): string {
    return this.config.get('VECTOR_COLLECTION_PREFIX', { infer: true });
  }
}
