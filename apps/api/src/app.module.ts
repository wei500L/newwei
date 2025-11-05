import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { WinstonModule } from "nest-winston";
import { utilities as nestWinstonModuleUtilities } from "nest-winston/dist/winston.utilities";
import * as winston from "winston";
import { ConfigModule } from "./modules/config/config.module";
import { HealthModule } from "./modules/health/health.module";
import { DatabaseModule } from "./modules/config/database.module";
import { AuthModule } from "./modules/auth/auth.module";
import { RbacModule } from "./modules/rbac/rbac.module";
import { ItemsModule } from "./modules/items/items.module";
import { QueueModule } from "./modules/queue/queue.module";
import { CacheModule } from "./modules/cache/cache.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { PermissionsGuard } from "./common/guards/permissions.guard";
import { ApiGraphqlModule } from "./graphql/graphql.module";

@Module({
  imports: [
    WinstonModule.forRoot({
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            nestWinstonModuleUtilities.format.nestLike("api", {
              colors: process.env.NODE_ENV !== "production"
            })
          )
        })
      ]
    }),
    ConfigModule,
    DatabaseModule,
    CacheModule,
    QueueModule,
    AuthModule,
    RbacModule,
    ItemsModule,
    DashboardModule,
    ApiGraphqlModule,
    HealthModule
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard
    }
  ]
})
export class AppModule {}
