import { createLogger, getCurrentTraceId } from "@modular/utils";
import {
  BadRequestException,
  Injectable,
  OnModuleDestroy,
} from "@nestjs/common";
import { isEmail } from "class-validator";
import Handlebars, { TemplateDelegate } from "handlebars";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import nodemailer, { Transporter } from "nodemailer";

import { EnvService } from "../config/config.service";

export interface SendEmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
}

interface AlertTemplateContext {
  ruleName: string;
  metric: string;
  value: number;
  thresholdLabel: string | number;
  triggeredAt: string;
  message?: string;
  changePercentLabel?: string;
}

type VerificationCodeScene = "bind" | "login";

interface VerificationCodeTemplateContext {
  actionLabel: string;
  code: string;
  expiresMinutes: number;
}

interface UserDigestTemplateEventContext {
  title: string;
  summary: string;
  itemCount: number;
  updatedAtLabel: string;
  link: string;
}

interface UserDigestTemplateContext {
  recipientName: string;
  generatedAtLabel: string;
  windowLabel: string;
  eventCount: number;
  digestLink: string;
  events: UserDigestTemplateEventContext[];
}

const ALERT_TEMPLATE_NAME = "alert.hbs";
const ALERT_TEXT_TEMPLATE_NAME = "alert.text.hbs";
const VERIFICATION_CODE_TEMPLATE_NAME = "verification-code.hbs";
const VERIFICATION_CODE_TEXT_TEMPLATE_NAME = "verification-code.text.hbs";
const USER_DIGEST_TEMPLATE_NAME = "user-digest.hbs";
const USER_DIGEST_TEXT_TEMPLATE_NAME = "user-digest.text.hbs";
const EMAIL_EXTRACT_REGEX =
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;

@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly logger = createLogger({ name: "email" });
  private readonly transporter: Transporter;
  private verifyInFlight: Promise<void> | null = null;
  private lastVerifyAtMs: number | null = null;
  private lastVerifyError: string | null = null;
  private readonly templates: {
    alert: TemplateDelegate<AlertTemplateContext>;
    alertText: TemplateDelegate<AlertTemplateContext>;
    verificationCode: TemplateDelegate<VerificationCodeTemplateContext>;
    verificationCodeText: TemplateDelegate<VerificationCodeTemplateContext>;
    userDigest: TemplateDelegate<UserDigestTemplateContext>;
    userDigestText: TemplateDelegate<UserDigestTemplateContext>;
  };

  constructor(private readonly env: EnvService) {
    const config = env.smtpConfig;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      ...(config.pool
        ? {
            pool: true,
            maxConnections: config.maxConnections,
            maxMessages: config.maxMessages,
            rateDelta: config.rateDeltaMs,
            rateLimit: config.rateLimit,
          }
        : {}),
      connectionTimeout: config.connectionTimeoutMs,
      greetingTimeout: config.greetingTimeoutMs,
      socketTimeout: config.socketTimeoutMs,
      tls: {
        rejectUnauthorized: config.tlsRejectUnauthorized,
      },
    });

    this.templates = {
      alert: this.compileTemplate<AlertTemplateContext>(ALERT_TEMPLATE_NAME),
      alertText: this.compileTemplate<AlertTemplateContext>(
        ALERT_TEXT_TEMPLATE_NAME,
      ),
      verificationCode: this.compileTemplate<VerificationCodeTemplateContext>(
        VERIFICATION_CODE_TEMPLATE_NAME,
      ),
      verificationCodeText:
        this.compileTemplate<VerificationCodeTemplateContext>(
          VERIFICATION_CODE_TEXT_TEMPLATE_NAME,
        ),
      userDigest: this.compileTemplate<UserDigestTemplateContext>(
        USER_DIGEST_TEMPLATE_NAME,
      ),
      userDigestText: this.compileTemplate<UserDigestTemplateContext>(
        USER_DIGEST_TEXT_TEMPLATE_NAME,
      ),
    };

    this.logger.debug(
      {
        host: config.host,
        port: config.port,
        secure: config.secure,
        pool: config.pool,
        from: config.from,
      },
      "SMTP transporter initialized",
    );
  }

  onModuleDestroy() {
    try {
      this.transporter.close();
    } catch (error) {
      this.logger.debug({ error }, "Failed to close SMTP transporter");
    }
  }

  async send(options: SendEmailOptions) {
    const from = options.from ?? this.env.smtpConfig.from;
    const to = this.normalizeEmailTarget(options.to);
    const cc = options.cc ? this.normalizeEmailTarget(options.cc) : undefined;
    const bcc = options.bcc
      ? this.normalizeEmailTarget(options.bcc)
      : undefined;
    const replyTo = options.replyTo
      ? this.normalizeEmailTarget(options.replyTo)
      : undefined;

    const traceId = getCurrentTraceId();
    const headers = traceId ? { "x-trace-id": traceId } : undefined;

    if (!options.text && !options.html) {
      throw new BadRequestException("Email requires either text or html");
    }

    try {
      const result = await this.transporter.sendMail({
        from,
        to,
        ...(cc ? { cc } : {}),
        ...(bcc ? { bcc } : {}),
        ...(replyTo ? { replyTo } : {}),
        subject: options.subject,
        text: options.text,
        html: options.html,
        ...(headers ? { headers } : {}),
      });
      this.logger.info(
        {
          messageId: result.messageId,
          accepted: result.accepted,
          rejected: result.rejected,
        },
        "Email sent",
      );
      return result;
    } catch (error) {
      this.logger.error({ error }, "Failed to send email");
      throw error;
    }
  }

  async verify() {
    return this.transporter.verify();
  }

  async verifyCached(ttlMs = 60_000) {
    const now = Date.now();
    if (this.lastVerifyAtMs !== null && now - this.lastVerifyAtMs < ttlMs) {
      if (this.lastVerifyError) {
        throw new Error(this.lastVerifyError);
      }
      return;
    }

    if (this.verifyInFlight) {
      return this.verifyInFlight;
    }

    this.verifyInFlight = this.transporter
      .verify()
      .then(() => {
        this.lastVerifyError = null;
      })
      .catch((error) => {
        this.lastVerifyError =
          (error as Error)?.message ?? "SMTP verify failed";
        throw error;
      })
      .finally(() => {
        this.lastVerifyAtMs = Date.now();
        this.verifyInFlight = null;
      });

    return this.verifyInFlight;
  }

  getVerifyStatus() {
    return {
      ok: this.lastVerifyAtMs === null ? null : this.lastVerifyError === null,
      checkedAt:
        this.lastVerifyAtMs === null
          ? null
          : new Date(this.lastVerifyAtMs).toISOString(),
      error: this.lastVerifyError,
    };
  }

  buildAlertTemplate(params: {
    ruleName: string;
    metric: string;
    value: number;
    threshold?: number | null;
    triggeredAt: string;
    message?: string;
    changePercent?: number | null;
  }) {
    const {
      ruleName,
      metric,
      value,
      threshold,
      triggeredAt,
      message,
      changePercent,
    } = params;
    const changePercentLabel =
      changePercent !== undefined && changePercent !== null
        ? changePercent.toFixed(2)
        : undefined;

    return this.templates.alert({
      ruleName,
      metric,
      value,
      thresholdLabel: threshold ?? "未设置",
      triggeredAt,
      message,
      changePercentLabel,
    });
  }

  buildAlertTextTemplate(params: {
    ruleName: string;
    metric: string;
    value: number;
    threshold?: number | null;
    triggeredAt: string;
    message?: string;
    changePercent?: number | null;
  }) {
    const {
      ruleName,
      metric,
      value,
      threshold,
      triggeredAt,
      message,
      changePercent,
    } = params;
    const changePercentLabel =
      changePercent !== undefined && changePercent !== null
        ? changePercent.toFixed(2)
        : undefined;

    return this.templates.alertText({
      ruleName,
      metric,
      value,
      thresholdLabel: threshold ?? "未设置",
      triggeredAt,
      message,
      changePercentLabel,
    });
  }

  buildVerificationCodeTemplate(params: {
    scene: VerificationCodeScene;
    code: string;
    expiresMinutes: number;
  }) {
    const { scene, code, expiresMinutes } = params;
    return this.templates.verificationCode({
      actionLabel: this.resolveVerificationActionLabel(scene),
      code,
      expiresMinutes,
    });
  }

  buildVerificationCodeTextTemplate(params: {
    scene: VerificationCodeScene;
    code: string;
    expiresMinutes: number;
  }) {
    const { scene, code, expiresMinutes } = params;
    return this.templates.verificationCodeText({
      actionLabel: this.resolveVerificationActionLabel(scene),
      code,
      expiresMinutes,
    });
  }

  buildUserDigestTemplate(params: UserDigestTemplateContext) {
    return this.templates.userDigest(params);
  }

  buildUserDigestTextTemplate(params: UserDigestTemplateContext) {
    return this.templates.userDigestText(params);
  }

  private compileTemplate<T>(templateFile: string): TemplateDelegate<T> {
    const templatePath = this.resolveTemplatePath(templateFile);
    if (!templatePath) {
      const expectedDir = path.resolve(__dirname, "templates");
      throw new Error(
        [
          `Email template not found: ${templateFile}`,
          `Expected under: ${expectedDir}`,
          `Hint: make sure build copies templates into dist (apps/api/scripts/copy-email-templates.js)`,
        ].join("\n"),
      );
    }

    const templateSource = readFileSync(templatePath, "utf-8");
    return Handlebars.compile<T>(templateSource);
  }

  private resolveTemplatePath(templateFile: string): string | null {
    const templatesDir = path.resolve(__dirname, "templates");
    const resolved = path.resolve(templatesDir, templateFile);

    if (path.isAbsolute(templateFile)) {
      return null;
    }

    const relative = path.relative(templatesDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }

    return existsSync(resolved) ? resolved : null;
  }

  normalizeEmailTarget(target: string): string {
    const emails = this.extractEmails(target);
    if (emails.length === 0) {
      throw new BadRequestException("Invalid email target");
    }
    return emails.join(", ");
  }

  private extractEmails(input: string): string[] {
    const normalized = input.trim();
    if (!normalized) {
      return [];
    }

    const matches = normalized.match(EMAIL_EXTRACT_REGEX) ?? [];
    const result = new Set<string>();
    for (const match of matches) {
      const candidate = match.trim();
      if (!candidate) {
        continue;
      }
      if (!isEmail(candidate)) {
        continue;
      }
      result.add(candidate);
    }
    return Array.from(result);
  }

  private resolveVerificationActionLabel(scene: VerificationCodeScene): string {
    if (scene === "bind") {
      return "邮箱绑定";
    }
    return "登录";
  }
}
