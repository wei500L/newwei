import { Module, Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { ConfigModule as ApiConfigModule } from "../src/modules/config/config.module";
import { EmailModule } from "../src/modules/email/email.module";
import { EmailService } from "../src/modules/email/email.service";

@Module({
  imports: [ApiConfigModule, EmailModule]
})
class EmailScriptModule {}

async function bootstrap() {
  const logger = new Logger("SendTestEmail");
  const [recipient, subjectArg] = process.argv.slice(2);

  if (!recipient) {
    logger.error("Usage: ts-node send-test-email.ts <recipient> [subject]");
    process.exit(1);
  }

  const subject = subjectArg ?? "Test email";
  const text = "This is a test email sent from the NestJS SMTP utility.";

  const app = await NestFactory.createApplicationContext(EmailScriptModule, {
    logger: ["error", "warn", "log"]
  });

  try {
    const emailService = app.get(EmailService);
    await emailService.verify();
    await emailService.send({ to: recipient, subject, text });
    logger.log(`Sent test email to ${recipient}`);
  } catch (error) {
    logger.error("Failed to send test email", error as Error);
    process.exit(1);
  } finally {
    await app.close();
  }
}

void bootstrap();
