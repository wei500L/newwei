import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";

import { CacheModule } from "../cache/cache.module";
import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../config/database.module";
import { EmailModule } from "../email/email.module";
import { OrgModule } from "../org/org.module";
import { StorageModule } from "../storage/storage.module";
import { UserNewsBehaviorModule } from "../user-news-behavior/user-news-behavior.module";

import { AccessTokenBlacklistService } from "./access-token-blacklist.service";
import { AuthSecurityService } from "./auth-security.service";
import { AuthCacheSettingsService } from "./auth-cache-settings.service";
import { AuthEmailCodeSettingsService } from "./auth-email-code-settings.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { MfaService } from "./mfa.service";
import { MachineTokenService } from "./machine-token.service";
import { OidcAuthService } from "./oidc-auth.service";
import { OrgInviteService } from "./org-invite.service";
import { PasswordResetService } from "./password-reset.service";
import { PlatformAccessService } from "./platform-access.service";
import { RegistrationApplicationService } from "./registration-application.service";
import { RefreshTokenBlacklistService } from "./refresh-token-blacklist.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { UserDataExportService } from "./user-data-export.service";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    ConfigModule,
    DatabaseModule,
    CacheModule,
    EmailModule,
    OrgModule,
    StorageModule,
    UserNewsBehaviorModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    AccessTokenBlacklistService,
    RefreshTokenBlacklistService,
    AuthCacheSettingsService,
    AuthEmailCodeSettingsService,
    AuthSecurityService,
    PlatformAccessService,
    MfaService,
    MachineTokenService,
    PasswordResetService,
    OrgInviteService,
    RegistrationApplicationService,
    OidcAuthService,
    UserDataExportService,
  ],
  exports: [
    AuthService,
    AccessTokenBlacklistService,
    RefreshTokenBlacklistService,
    AuthCacheSettingsService,
    AuthEmailCodeSettingsService,
    AuthSecurityService,
    PlatformAccessService,
    MfaService,
    MachineTokenService,
    PasswordResetService,
    OrgInviteService,
    RegistrationApplicationService,
    OidcAuthService,
    UserDataExportService,
  ],
})
export class AuthModule {}
