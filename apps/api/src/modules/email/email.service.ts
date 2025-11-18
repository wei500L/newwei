import { Injectable } from "@nestjs/common";
import nodemailer, { Transporter } from "nodemailer";

import { EnvService } from "../config/config.service";

export interface SendEmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
}

@Injectable()
export class EmailService {
  private readonly transporter: Transporter;

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
    return `
      <h3>告警触发：${ruleName}</h3>
      <p>指标：${metric}</p>
      <p>当前值：${value}${changePercent !== undefined && changePercent !== null ? `（变化：${changePercent.toFixed(2)}%）` : ""}</p>
      <p>阈值：${threshold ?? "未设置"}</p>
      <p>时间：${triggeredAt}</p>
      ${message ? `<p>详情：${message}</p>` : ""}
    `;
  }
}
