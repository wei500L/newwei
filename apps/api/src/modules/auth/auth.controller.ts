import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";

import { AuthService } from "./auth.service";
import type { AuthenticatedUser } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { LogoutDto } from "./dto/logout.dto";
import { RefreshDto } from "./dto/refresh.dto";



@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(
      body.email,
      body.password,
      body.orgId,
      req.ip,
      req.get("user-agent") ?? undefined
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
      req.get("user-agent") ?? undefined
    );
  }

  @Post("logout")
  @AllowAuthenticated()
  async logout(@CurrentUser() user: AuthenticatedUser, @Body() body: LogoutDto) {
    await this.authService.logout(
      user.id,
      user.orgId,
      body?.refreshToken,
      user.accessTokenId,
      user.accessTokenExpiresAt,
      body?.logoutAll
    );
    return { ok: true };
  }

  @Get("me")
  @AllowAuthenticated()
  async profile(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
