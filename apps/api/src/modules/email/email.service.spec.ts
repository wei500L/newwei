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
      tlsRejectUnauthorized: true
    }
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
      changePercent: 12.345
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
      changePercent: 12.345
    });

    expect(text).toContain("告警触发：CPU高");
    expect(text).toContain("指标：cpu_usage");
    expect(text).toContain("当前值：92");
    expect(text).toContain("阈值：90");
    expect(text).toContain("时间：2025-12-13 00:00:00");
    expect(text).toContain("详情：超过阈值");
  });

  it("rejects path traversal attempts when resolving templates", () => {
    const service = new EmailService(envStub) as unknown as {
      resolveTemplatePath: (templateFile: string) => string | null;
    };

    expect(service.resolveTemplatePath("../alert.hbs")).toBeNull();
    expect(service.resolveTemplatePath("/etc/passwd")).toBeNull();
  });
});
