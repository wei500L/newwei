import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { StorageService } from "../storage/storage.service";

import { AuthService } from "./auth.service";
import type { AuthenticatedUser } from "./auth.service";
import {
  AvatarPresignRequestDto,
  AvatarPresignResponseDto,
} from "./dto/avatar.dto";
import {
  EmailCodeSendResponseDto,
  SendVerificationDto,
  VerifyEmailDto,
} from "./dto/email-verification.dto";
import { LoginWithCodeDto, SendLoginCodeDto } from "./dto/login-with-code.dto";
import { LoginDto } from "./dto/login.dto";
import { LogoutDto } from "./dto/logout.dto";
import { UpdateProfileDto } from "./dto/profile.dto";
import { RefreshDto } from "./dto/refresh.dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly storageService: StorageService,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(
      body.email,
      body.password,
      body.orgId,
      req.ip,
      req.get("user-agent") ?? undefined,
    );
    return result;
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

  @Get("me")
  @AllowAuthenticated()
  async profile(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
