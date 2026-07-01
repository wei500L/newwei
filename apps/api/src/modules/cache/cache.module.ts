import { createLogger } from '@modular/utils';
import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { EnvService } from '../config/config.service';
import { toIoredisConnection } from '../config/redis-connection';

import { ActionRateLimitService } from './action-rate-limit.service';
import { CacheService } from './cache.service';
import { REDIS_CLIENT } from './cache.tokens';
import { RateLimiterService } from './rate-limiter.service';

const logger = createLogger({ name: 'cache-redis' });

@Injectable()
class RedisClientCleanup implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const redis = new Redis(toIoredisConnection(env.redisConfig));

        redis.on('error', (error) => {
          logger.warn({ error }, 'Redis cache client error');
        });

        return redis;
      }
    },
    CacheService,
    RateLimiterService,
    ActionRateLimitService,
    RedisClientCleanup
  ],
  exports: [CacheService, RateLimiterService, ActionRateLimitService, REDIS_CLIENT]
})
export class CacheModule {}
