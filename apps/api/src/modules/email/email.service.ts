import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { Injectable } from "@nestjs/common";
import Handlebars, { TemplateDelegate } from "handlebars";
import nodemailer, { Transporter } from "nodemailer";

import { EnvService } from "../config/config.service";

export interface SendEmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
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

const ALERT_TEMPLATE_NAME = "alert.hbs";

@Injectable()
export class EmailService {
  private readonly transporter: Transporter;
  private readonly templates: {
    alert: TemplateDelegate<AlertTemplateContext>;
  };

  constructor(private readonly env: EnvService) {
    const config = env.smtpConfig;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass
      }
    });

    this.templates = {
      alert: this.compileTemplate<AlertTemplateContext>(ALERT_TEMPLATE_NAME)
    };
  }

  async send(options: SendEmailOptions) {
    const from = options.from ?? this.env.smtpConfig.from;
    if (!from) {
      throw new Error("Missing SMTP_FROM or sender address");
    }

    return this.transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html
    });
  }

  async verify() {
    return this.transporter.verify();
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
    const { ruleName, metric, value, threshold, triggeredAt, message, changePercent } = params;
    const changePercentLabel =
      changePercent !== undefined && changePercent !== null ? changePercent.toFixed(2) : undefined;

    return this.templates.alert({
      ruleName,
      metric,
      value,
      thresholdLabel: threshold ?? "未设置",
      triggeredAt,
      message,
      changePercentLabel
    });
  }

  private compileTemplate<T>(templateFile: string): TemplateDelegate<T> {
    const templatePath = this.resolveTemplatePath(templateFile);
    if (!templatePath) {
      throw new Error(`Email template not found: ${templateFile}`);
    }

    const templateSource = readFileSync(templatePath, "utf-8");
    return Handlebars.compile<T>(templateSource);
  }

  private resolveTemplatePath(templateFile: string): string | null {
    const isBuiltArtifact = __dirname.includes(`${path.sep}dist${path.sep}`);
    const packageRoot = isBuiltArtifact
      ? path.resolve(__dirname, "..", "..", "..", "..")
      : path.resolve(__dirname, "..", "..", "..");
    const candidates = [
      path.join(__dirname, "templates", templateFile),
      path.join(packageRoot, "dist", "src", "modules", "email", "templates", templateFile),
      path.join(packageRoot, "src", "modules", "email", "templates", templateFile)
    ];

    const existingPath = candidates.find((candidate) => existsSync(candidate));
    return existingPath ?? null;
  }
}
