import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import type { Response } from "express";

import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { EnvService } from "../config/config.service";
import { StorageService } from "../storage/storage.service";

import { AuthService } from "./auth.service";
import type { AuthenticatedUser } from "./auth.service";
import {
  AcceptInviteDto,
  ApproveJoinApplicationDto,
  CreateInviteDto,
  ExchangeHandoffTokenDto,
  RejectApplicationDto,
  SubmitJoinOrgApplicationDto,
  SubmitNewOrgApplicationDto,
} from "./dto/identity-admin.dto";
import { CompleteMfaLoginDto, OidcConfigDto, VerifyMfaCodeDto } from "./dto/mfa.dto";
import {
  AvatarPresignRequestDto,
  AvatarPresignResponseDto,
} from "./dto/avatar.dto";
import {
  EmailCodeSendResponseDto,
  SendVerificationDto,
  VerifyEmailDto,
} from "./dto/email-verification.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { LoginWithCodeDto, SendLoginCodeDto } from "./dto/login-with-code.dto";
import { LoginDto } from "./dto/login.dto";
import { LogoutDto } from "./dto/logout.dto";
import { RequestPasswordResetDto, ResetPasswordDto } from "./dto/password-reset.dto";
import { MfaService } from "./mfa.service";
import { OidcAuthService } from "./oidc-auth.service";
import { OrgInviteService } from "./org-invite.service";
import { PasswordResetService } from "./password-reset.service";
import { PlatformAccessService } from "./platform-access.service";
import { UpdateProfileDto } from "./dto/profile.dto";
import { RegistrationApplicationService } from "./registration-application.service";
import { RefreshDto } from "./dto/refresh.dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly storageService: StorageService,
    private readonly passwordResetService: PasswordResetService,
    private readonly inviteService: OrgInviteService,
    private readonly registrationApplications: RegistrationApplicationService,
    private readonly mfaService: MfaService,
    private readonly oidcAuthService: OidcAuthService,
    private readonly platformAccess: PlatformAccessService,
    private readonly env: EnvService,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: Request) {
    return this.authService.login(
      body.email,
      body.password,
      body.orgId,
      req.ip,
      req.get("user-agent") ?? undefined,
    );
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(
      body.refreshToken,
      body.orgId,
      req.ip,
      req.get("user-agent") ?? undefined,
    );
  }

  @Post("send-verification")
  @HttpCode(200)
  @AllowAuthenticated()
  async sendVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SendVerificationDto,
    @Req() req: Request,
  ): Promise<EmailCodeSendResponseDto> {
    return this.authService.sendVerificationCode(
      user.id,
      user.orgId,
      body.email,
      req.ip,
    );
  }

  @Post("verify-email")
  @HttpCode(200)
  @AllowAuthenticated()
  async verifyEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: VerifyEmailDto,
    @Req() req: Request,
  ) {
    return this.authService.verifyEmail(user.id, user.orgId, body.code, req.ip);
  }

  @Public()
  @Post("send-login-code")
  @HttpCode(200)
  async sendLoginCode(
    @Body() body: SendLoginCodeDto,
  ): Promise<EmailCodeSendResponseDto> {
    return this.authService.sendLoginCode(body.email);
  }

  @Public()
  @Post("login-with-code")
  @HttpCode(200)
  async loginWithCode(@Body() body: LoginWithCodeDto, @Req() req: Request) {
    return this.authService.loginWithCode(
      body.email,
      body.code,
      body.orgId,
      req.ip,
      req.get("user-agent") ?? undefined,
    );
  }

  @Public()
  @Post("password/forgot")
  @HttpCode(200)
  async requestPasswordReset(
    @Body() body: RequestPasswordResetDto,
    @Req() req: Request,
  ) {
    const baseUrl =
      this.env.get<string>("NEXTAUTH_URL", { infer: true }) ??
      process.env.NEXTAUTH_URL ??
      "http://localhost:3000";
    return this.passwordResetService.requestReset({
      email: body.email,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
      baseUrl,
    });
  }

  @Public()
  @Post("password/reset")
  @HttpCode(200)
  async resetPassword(@Body() body: ResetPasswordDto, @Req() req: Request) {
    return this.passwordResetService.resetPassword({
      token: body.token,
      password: body.password,
      ipAddress: req.ip,
    });
  }

  @Get("mfa")
  @AllowAuthenticated()
  async getMfaStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.mfaService.getStatus(user.id);
  }

  @Post("mfa/enroll")
  @AllowAuthenticated()
  async beginMfaEnrollment(@CurrentUser() user: AuthenticatedUser) {
    return this.mfaService.beginEnrollment(user.id, user.email);
  }

  @Post("mfa/verify-enroll")
  @AllowAuthenticated()
  async verifyMfaEnrollment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: VerifyMfaCodeDto,
  ) {
    return this.mfaService.verifyEnrollment(user.id, body.code);
  }

  @Post("mfa/disable")
  @AllowAuthenticated()
  async disableMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: VerifyMfaCodeDto,
  ) {
    return this.mfaService.disable(user.id, body.code);
  }

  @Post("mfa/recovery/rotate")
  @AllowAuthenticated()
  async rotateRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: VerifyMfaCodeDto,
  ) {
    return this.mfaService.rotateRecoveryCodes(user.id, body.code);
  }

  @Public()
  @Post("mfa/verify-login")
  @HttpCode(200)
  async completeMfaLogin(
    @Body() body: CompleteMfaLoginDto,
    @Req() req: Request,
  ) {
    return this.authService.completeMfaLogin(
      body.challengeId,
      body.code,
      req.ip,
      req.get("user-agent") ?? undefined,
    );
  }

  @Permissions("settings.manage")
  @Get("admin/oidc-config")
  async getOidcConfig(@CurrentUser() user: AuthenticatedUser) {
    return this.oidcAuthService.getConfig(user.orgId);
  }

  @Permissions("settings.manage")
  @Put("admin/oidc-config")
  async updateOidcConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: OidcConfigDto,
  ) {
    return this.oidcAuthService.updateConfig({
      orgId: user.orgId,
      actorId: user.id,
      enabled: body.enabled,
      issuerUrl: body.issuerUrl,
      discoveryUrl: body.discoveryUrl,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      scopes: body.scopes,
      buttonLabel: body.buttonLabel,
    });
  }

  @Permissions("users.write")
  @Get("admin/invites")
  async listInvites(@CurrentUser() user: AuthenticatedUser) {
    return this.inviteService.listInvites(user.orgId, user.id);
  }

  @Permissions("users.write")
  @Post("admin/invites")
  async createInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateInviteDto,
  ) {
    const baseUrl =
      this.env.get<string>("NEXTAUTH_URL", { infer: true }) ??
      process.env.NEXTAUTH_URL ??
      "http://localhost:3000";
    return this.inviteService.createInvite(user.orgId, user.id, body, baseUrl);
  }

  @Permissions("users.write")
  @Post("admin/invites/:id/resend")
  async resendInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") inviteId: string,
  ) {
    const baseUrl =
      this.env.get<string>("NEXTAUTH_URL", { infer: true }) ??
      process.env.NEXTAUTH_URL ??
      "http://localhost:3000";
    return this.inviteService.resendInvite(user.orgId, user.id, inviteId, baseUrl);
  }

  @Permissions("users.write")
  @Post("admin/invites/:id/revoke")
  async revokeInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") inviteId: string,
  ) {
    return this.inviteService.revokeInvite(user.orgId, user.id, inviteId);
  }

  @Permissions("users.write")
  @Get("admin/registration-applications")
  async listRegistrationApplications(@CurrentUser() user: AuthenticatedUser) {
    const isPlatformAdmin = await this.platformAccess.isPlatformAdmin(user.id);
    const [orgApplications, platformApplications] = await Promise.all([
      this.registrationApplications.listOrgJoinApplications(user.orgId, user.id),
      isPlatformAdmin
        ? this.registrationApplications.listPlatformApplications(user.id)
        : Promise.resolve([]),
    ]);
    return {
      orgApplications,
      platformApplications,
    };
  }

  @Permissions("users.write")
  @Post("admin/registration-applications/:id/approve-join")
  async approveJoinApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") applicationId: string,
    @Body() body: ApproveJoinApplicationDto,
  ) {
    const baseUrl =
      this.env.get<string>("NEXTAUTH_URL", { infer: true }) ??
      process.env.NEXTAUTH_URL ??
      "http://localhost:3000";
    return this.registrationApplications.approveJoinApplication({
      actorId: user.id,
      orgId: user.orgId,
      applicationId,
      primaryRoleId: body.primaryRoleId,
      roleIds: body.roleIds,
      baseUrl,
    });
  }

  @Permissions("users.write")
  @Post("admin/registration-applications/:id/reject-join")
  async rejectJoinApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") applicationId: string,
    @Body() body: RejectApplicationDto,
  ) {
    return this.registrationApplications.rejectJoinApplication({
      actorId: user.id,
      orgId: user.orgId,
      applicationId,
      reason: body.reason,
    });
  }

  @AllowAuthenticated()
  @Post("admin/registration-applications/:id/approve-org")
  async approveNewOrgApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") applicationId: string,
  ) {
    const baseUrl =
      this.env.get<string>("NEXTAUTH_URL", { infer: true }) ??
      process.env.NEXTAUTH_URL ??
      "http://localhost:3000";
    return this.registrationApplications.approveNewOrgApplication({
      actorId: user.id,
      applicationId,
      baseUrl,
    });
  }

  @AllowAuthenticated()
  @Post("admin/registration-applications/:id/reject-org")
  async rejectNewOrgApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") applicationId: string,
    @Body() body: RejectApplicationDto,
  ) {
    return this.registrationApplications.rejectNewOrgApplication({
      actorId: user.id,
      applicationId,
      reason: body.reason,
    });
  }

  @Public()
  @Post("register/applications")
  @HttpCode(200)
  async submitNewOrgApplication(@Body() body: SubmitNewOrgApplicationDto) {
    return this.registrationApplications.submitNewOrgApplication(body);
  }

  @Public()
  @Post("register/join-applications")
  @HttpCode(200)
  async submitJoinOrgApplication(@Body() body: SubmitJoinOrgApplicationDto) {
    return this.registrationApplications.submitJoinOrgApplication(body);
  }

  @Public()
  @Get("invitations/:token")
  async getInvitation(@Param("token") token: string) {
    return this.inviteService.getInviteByToken(token);
  }

  @Public()
  @Post("invitations/:token/accept")
  async acceptInvitation(
    @Param("token") token: string,
    @Body() body: AcceptInviteDto,
  ) {
    return this.inviteService.acceptInvite({
      token,
      password: body.password,
      firstName: body.firstName,
      lastName: body.lastName,
    });
  }

  @Post("invitations/:token/accept-authenticated")
  @AllowAuthenticated()
  async acceptInvitationAuthenticated(
    @Param("token") token: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inviteService.acceptInvite({
      token,
      currentUserId: user.id,
    });
  }

  @Public()
  @Get("sso/oidc/start")
  async startOidcLogin(@Query("org") org: string, @Res() res: Response) {
    const url = await this.oidcAuthService.buildAuthorizationUrl(org);
    return res.redirect(url);
  }

  @Public()
  @Get("oidc/callback")
  async handleOidcCallback(
    @Query("state") state: string | undefined,
    @Query("code") code: string | undefined,
    @Query("error") error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const nextAuthUrl =
      this.env.get<string>("NEXTAUTH_URL", { infer: true }) ??
      process.env.NEXTAUTH_URL ??
      "http://localhost:3000";
    const callbackUrl = new URL("/auth/sso/callback", nextAuthUrl);
    try {
      const result = await this.oidcAuthService.handleCallback({
        state,
        code,
        error,
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      });
      if ("handoffToken" in result) {
        callbackUrl.searchParams.set("handoffToken", result.handoffToken);
      } else {
        callbackUrl.searchParams.set("challengeId", result.authChallengeId);
      }
    } catch (oidcError) {
      callbackUrl.searchParams.set(
        "error",
        oidcError instanceof Error ? oidcError.message : "OIDC login failed",
      );
    }
    return res.redirect(callbackUrl.toString());
  }

  @Public()
  @Post("sso/handoff/exchange")
  @HttpCode(200)
  async exchangeHandoffToken(@Body() body: ExchangeHandoffTokenDto) {
    return this.oidcAuthService.exchangeHandoffToken(body.handoffToken);
  }

  @Post("logout")
  @AllowAuthenticated()
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: LogoutDto,
  ) {
    await this.authService.logout(
      user.id,
      user.orgId,
      body?.refreshToken,
      user.accessTokenId,
      user.accessTokenExpiresAt,
      body?.logoutAll,
    );
    return { ok: true };
  }

  @Post("avatar/presigned-url")
  @AllowAuthenticated()
  async createAvatarPresignedUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: AvatarPresignRequestDto,
  ): Promise<AvatarPresignResponseDto> {
    return this.storageService.createAvatarUploadUrl({
      userId: user.id,
      orgId: user.orgId,
      contentType: body.contentType,
      contentLength: body.contentLength,
    });
  }

  @Patch("profile")
  @AllowAuthenticated()
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(user.id, user.orgId, body);
  }

  @Post("change-password")
  @HttpCode(200)
  @AllowAuthenticated()
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ChangePasswordDto,
  ) {
    await this.authService.changePassword(
      user.id,
      user.orgId,
      body.currentPassword,
      body.newPassword,
    );
    return { ok: true };
  }

  @Get("me")
  @AllowAuthenticated()
  async profile(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
