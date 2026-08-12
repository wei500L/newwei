import { Body, Controller, Get, Post, Put } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags
} from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { AuthEmailCodeSettingsService } from "../auth/auth-email-code-settings.service";
import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";
import { EnvService } from "../config/config.service";
import { EmailService } from "../email/email.service";

import { UpdateAuthEmailCodeSettingsDto } from "./dto/auth-email-code-settings.dto";
import { EmailSettingsStatusResponseDto } from "./dto/email-settings-status.dto";
import { EmailTestDto, EmailTestResponseDto } from "./dto/email-test.dto";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/email")
export class EmailSettingsController {
  constructor(
    private readonly env: EnvService,
    private readonly email: EmailService,
    private readonly authEmailCodeSettings: AuthEmailCodeSettingsService,
    private readonly platformAccess: PlatformAccessService
  ) {}

  @Get()
  @Permissions("settings.manage")
  @ApiOperation({
    summary: "Get email runtime settings",
    description:
      "Returns SMTP status plus effective email verification code settings used by email binding and code login."
  })
  @ApiOkResponse({ type: EmailSettingsStatusResponseDto })
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
  @ApiOperation({
    summary: "Update email verification code settings",
    description:
      "Persists email verification code settings to MySQL system settings and applies them immediately."
  })
  @ApiBody({ type: UpdateAuthEmailCodeSettingsDto })
  @ApiOkResponse({ type: UpdateAuthEmailCodeSettingsDto })
  async updateAuthCodeSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateAuthEmailCodeSettingsDto
  ) {
    // Email-code settings are GLOBAL (single key, no org dimension).
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.authEmailCodeSettings.updateSettings(user.orgId, user.id, body);
  }

  @Post("test")
  @Permissions("settings.manage")
  @ApiOperation({
    summary: "Send SMTP test email",
    description:
      "Sends a test email via configured SMTP transport to validate runtime email delivery configuration."
  })
  @ApiBody({ type: EmailTestDto })
  @ApiOkResponse({ type: EmailTestResponseDto })
  async test(@Body() body: EmailTestDto) {
    const smtpUser = this.env.smtpConfig.user;
    const recipient = body.to?.trim() || smtpUser;
    // Restrict the test endpoint to the configured SMTP account: otherwise a
    // settings.manage holder could use the global sender as a spam relay to
    // arbitrary addresses.
    const configuredDomain = smtpUser?.split("@")[1]?.toLowerCase();
    const recipientDomain = recipient.split("@")[1]?.toLowerCase();
    if (
      !configuredDomain ||
      !recipientDomain ||
      recipientDomain !== configuredDomain ||
      recipient.toLowerCase() !== smtpUser.toLowerCase()
    ) {
      return {
        ok: false,
        error:
          "Test emails may only be sent to the configured SMTP account to prevent relay abuse",
      };
    }
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
