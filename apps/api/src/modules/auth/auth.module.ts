import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";

import { CacheModule } from "../cache/cache.module";
import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../config/database.module";
import { OrgModule } from "../org/org.module";
import { StorageModule } from "../storage/storage.module";

import { AccessTokenBlacklistService } from "./access-token-blacklist.service";
import { AuthCacheSettingsService } from "./auth-cache-settings.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";


@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    ConfigModule,
    DatabaseModule,
    CacheModule,
    OrgModule,
    StorageModule
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, AccessTokenBlacklistService, AuthCacheSettingsService],
  exports: [AuthService, AccessTokenBlacklistService, AuthCacheSettingsService]
})
export class AuthModule {}
