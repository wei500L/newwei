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
  private readonly packageRoot: string | null;
  private readonly templates: {
    alert: TemplateDelegate<AlertTemplateContext>;
  };

  constructor(private readonly env: EnvService) {
    const config = env.smtpConfig;
    this.packageRoot = this.findPackageRoot();
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
    const candidateDirectories = new Set<string>([
      path.join(__dirname, "templates")
    ]);

    if (this.packageRoot) {
      candidateDirectories.add(
        path.join(this.packageRoot, "src", "modules", "email", "templates")
      );
      candidateDirectories.add(
        path.join(this.packageRoot, "dist", "src", "modules", "email", "templates")
      );
    }

    const cwd = process.cwd();
    candidateDirectories.add(path.join(cwd, "src", "modules", "email", "templates"));
    candidateDirectories.add(path.join(cwd, "dist", "src", "modules", "email", "templates"));
    candidateDirectories.add(
      path.join(cwd, "apps", "api", "src", "modules", "email", "templates")
    );
    candidateDirectories.add(
      path.join(cwd, "apps", "api", "dist", "src", "modules", "email", "templates")
    );

    for (const directory of candidateDirectories) {
      const candidate = path.join(directory, templateFile);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private findPackageRoot(): string | null {
    const searchStarts = [__dirname, process.cwd()];

    for (const start of searchStarts) {
      const packageRoot = this.walkUpForPackage(start);
      if (packageRoot) {
        return packageRoot;
      }
    }

    return null;
  }

  private walkUpForPackage(startFrom: string): string | null {
    let current = path.resolve(startFrom);
    const { root } = path.parse(current);

    while (current && current !== root) {
      const packageJsonPath = path.join(current, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
          if (packageJson?.name === "@modular/api") {
            return current;
          }
        } catch {
          // ignore malformed package.json files and keep searching upward
        }
      }

      current = path.dirname(current);
    }

    return null;
  }
}
