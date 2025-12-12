import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../config/database.module";
import { CacheModule } from "../cache/cache.module";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { AccessTokenBlacklistService } from "./access-token-blacklist.service";
import { AuthCacheSettingsService } from "./auth-cache-settings.service";
import { OrgModule } from "../org/org.module";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    ConfigModule,
    DatabaseModule,
    CacheModule,
    OrgModule
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, AccessTokenBlacklistService, AuthCacheSettingsService],
  exports: [AuthService, AccessTokenBlacklistService, AuthCacheSettingsService]
})
export class AuthModule {}
