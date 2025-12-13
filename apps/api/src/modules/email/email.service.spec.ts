import { EmailService } from "./email.service";
import type { EnvService } from "../config/config.service";

describe("EmailService templates", () => {
  const envStub = {
    smtpConfig: {
      host: "localhost",
      port: 587,
      secure: false,
      user: "user",
      pass: "pass",
      from: "noreply@example.com"
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

  it("rejects path traversal attempts when resolving templates", () => {
    const service = new EmailService(envStub) as unknown as {
      resolveTemplatePath: (templateFile: string) => string | null;
    };

    expect(service.resolveTemplatePath("../alert.hbs")).toBeNull();
    expect(service.resolveTemplatePath("/etc/passwd")).toBeNull();
  });
});

