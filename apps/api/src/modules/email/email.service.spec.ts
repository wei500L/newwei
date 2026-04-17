import type { EnvService } from "../config/config.service";

import { EmailService } from "./email.service";

describe("EmailService templates", () => {
  const envStub = {
    smtpConfig: {
      host: "localhost",
      port: 587,
      secure: false,
      user: "user",
      pass: "pass",
      from: "noreply@example.com",
      pool: false,
      maxConnections: 5,
      maxMessages: 100,
      rateDeltaMs: 1_000,
      rateLimit: 10,
      connectionTimeoutMs: 10_000,
      greetingTimeoutMs: 10_000,
      socketTimeoutMs: 30_000,
      tlsRejectUnauthorized: true,
    },
  } as unknown as EnvService;

  it("loads and renders alert.hbs from the module templates directory", () => {
    const service = new EmailService(envStub);
    const html = service.buildAlertTemplate({
      ruleName: "CPU高",
      metric: "cpu_usage",
      value: 92,
      threshold: 90,
      triggeredAt: "2025-12-13 00:00:00",
      message: "超过阈值",
      changePercent: 12.345,
    });

    expect(html).toContain("告警触发：CPU高");
    expect(html).toContain("指标：cpu_usage");
    expect(html).toContain("当前值：92");
    expect(html).toContain("阈值：90");
    expect(html).toContain("时间：2025-12-13 00:00:00");
    expect(html).toContain("详情：超过阈值");
  });

  it("loads and renders alert.text.hbs as a plain-text fallback", () => {
    const service = new EmailService(envStub);
    const text = service.buildAlertTextTemplate({
      ruleName: "CPU高",
      metric: "cpu_usage",
      value: 92,
      threshold: 90,
      triggeredAt: "2025-12-13 00:00:00",
      message: "超过阈值",
      changePercent: 12.345,
    });

    expect(text).toContain("告警触发：CPU高");
    expect(text).toContain("指标：cpu_usage");
    expect(text).toContain("当前值：92");
    expect(text).toContain("阈值：90");
    expect(text).toContain("时间：2025-12-13 00:00:00");
    expect(text).toContain("详情：超过阈值");
  });

  it("loads and renders verification code templates", () => {
    const service = new EmailService(envStub);
    const html = service.buildVerificationCodeTemplate({
      scene: "bind",
      code: "12345678",
      expiresMinutes: 5,
    });
    const text = service.buildVerificationCodeTextTemplate({
      scene: "login",
      code: "87654321",
      expiresMinutes: 5,
    });

    expect(html).toContain("邮箱绑定验证码");
    expect(html).toContain("12345678");
    expect(text).toContain("登录验证码");
    expect(text).toContain("87654321");
  });

  it("loads and renders user digest templates", () => {
    const service = new EmailService(envStub);
    const html = service.buildUserDigestTemplate({
      recipientName: "Ada",
      generatedAtLabel: "2026-04-18 08:30",
      windowLabel: "3 天",
      eventCount: 2,
      digestLink: "http://localhost:3000/today",
      events: [
        {
          title: "Macro risk",
          summary: "Summary 1",
          itemCount: 3,
          updatedAtLabel: "2026-04-18 08:20",
          link: "https://example.com/story-1",
        },
      ],
    });
    const text = service.buildUserDigestTextTemplate({
      recipientName: "Ada",
      generatedAtLabel: "2026-04-18 08:30",
      windowLabel: "3 天",
      eventCount: 2,
      digestLink: "http://localhost:3000/today",
      events: [
        {
          title: "Macro risk",
          summary: "Summary 1",
          itemCount: 3,
          updatedAtLabel: "2026-04-18 08:20",
          link: "https://example.com/story-1",
        },
      ],
    });

    expect(html).toContain("Ada");
    expect(html).toContain("Macro risk");
    expect(html).toContain("http://localhost:3000/today");
    expect(text).toContain("Summary 1");
    expect(text).toContain("https://example.com/story-1");
  });

  it("rejects path traversal attempts when resolving templates", () => {
    const service = new EmailService(envStub) as unknown as {
      resolveTemplatePath: (templateFile: string) => string | null;
    };

    expect(service.resolveTemplatePath("../alert.hbs")).toBeNull();
    expect(service.resolveTemplatePath("/etc/passwd")).toBeNull();
  });
});
