import { createLogger } from "@modular/utils";
import { Global, Module } from "@nestjs/common";
import { ConfigModule as NestConfigModule } from "@nestjs/config";
import path from "node:path";

import { EnvService } from "./config.service";
import { apiEnvSchema } from "./env.schema";

const logger = createLogger({ name: "api-config" });

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile: process.env.CI === "true",
      envFilePath: [
        path.resolve(process.cwd(), ".env"),
        path.resolve(process.cwd(), "../../.env"),
      ],
      validate: (config) => {
        const result = apiEnvSchema.safeParse(config);
        if (!result.success) {
          const formatted = result.error.format();
          logger.error({ errors: formatted }, "Environment validation failed");
          throw new Error("Invalid environment configuration");
        }
        return result.data;
      },
    }),
  ],
  providers: [EnvService],
  exports: [EnvService],
})
export class ConfigModule {}
