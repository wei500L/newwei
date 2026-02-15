import { Body, Controller, Get, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { AuthEmailCodeSettingsService } from "../auth/auth-email-code-settings.service";
import type { AuthenticatedUser } from "../auth/auth.service";
import { EnvService } from "../config/config.service";
import { EmailService } from "../email/email.service";

import { UpdateAuthEmailCodeSettingsDto } from "./dto/auth-email-code-settings.dto";
import { EmailTestDto } from "./dto/email-test.dto";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/email")
export class EmailSettingsController {
  constructor(
    private readonly env: EnvService,
    private readonly email: EmailService,
    private readonly authEmailCodeSettings: AuthEmailCodeSettingsService
  ) {}

  @Get()
  @Permissions("settings.manage")
  async getStatus() {
    try {
      await this.email.verifyCached(60_000);
    } catch {
      // keep verify error in response
    }

    const smtp = this.env.smtpConfig;
    return {
      smtp: {
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        user: smtp.user,
        from: smtp.from,
        pool: smtp.pool,
        maxConnections: smtp.maxConnections,
        maxMessages: smtp.maxMessages,
        rateDeltaMs: smtp.rateDeltaMs,
        rateLimit: smtp.rateLimit,
        connectionTimeoutMs: smtp.connectionTimeoutMs,
        greetingTimeoutMs: smtp.greetingTimeoutMs,
        socketTimeoutMs: smtp.socketTimeoutMs,
        tlsRejectUnauthorized: smtp.tlsRejectUnauthorized
      },
      verify: this.email.getVerifyStatus(),
      authCode: await this.authEmailCodeSettings.getSettings()
    };
  }

  @Put("auth-code")
  @Permissions("settings.manage")
  async updateAuthCodeSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateAuthEmailCodeSettingsDto
  ) {
    return this.authEmailCodeSettings.updateSettings(user.orgId, user.id, body);
  }

  @Post("test")
  @Permissions("settings.manage")
  async test(@Body() body: EmailTestDto) {
    const recipient = body.to?.trim() || this.env.smtpConfig.user;
    const subject = body.subject?.trim() || "Test email";
    await this.email.verifyCached(0);

    const nowIso = new Date().toISOString();
    const text = `This is a test email sent from Modular API at ${nowIso}.`;
    const html = `<p>This is a test email sent from <strong>Modular API</strong>.</p><p>Time: ${nowIso}</p>`;

    const result = await this.email.send({
      to: recipient,
      subject,
      text,
      html
    });

    return {
      to: recipient,
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected
    };
  }
}
