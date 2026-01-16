import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { TraceIdMiddleware } from './common/middleware/trace-id.middleware';
import { ConfigModule } from './modules/config/config.module';
import { HealthModule } from './modules/health/health.module';
import { InternalAuthGuard } from './modules/internal-auth/internal-auth.guard';
import { VectorModule } from './modules/vector/vector.module';

@Module({
  imports: [ConfigModule, HealthModule, VectorModule],
  providers: [
    {
      provide: APP_GUARD,
      useClass: InternalAuthGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}

