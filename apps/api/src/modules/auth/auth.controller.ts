import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import type { Request } from "express";
import type { AuthenticatedUser } from "./auth.service";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(body.email, body.password, req.ip, req.get("user-agent") ?? undefined);
    return result;
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(body.refreshToken, req.ip, req.get("user-agent") ?? undefined);
  }

  @Post("logout")
  @AllowAuthenticated()
  async logout(@CurrentUser() user: AuthenticatedUser, @Body("refreshToken") refreshToken?: string) {
    await this.authService.logout(user.id, refreshToken);
    return { ok: true };
  }

  @Get("me")
  @AllowAuthenticated()
  async profile(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
