import { createLogger } from "@modular/utils";
import { Global, Module } from "@nestjs/common";
import { ConfigModule as NestConfigModule } from "@nestjs/config";
import path from "node:path";

import { EnvService } from "./config.service";
import { vectorEnvSchema } from "./env.schema";

const logger = createLogger({ name: "vector-config" });

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
        const result = vectorEnvSchema.safeParse(config);
        if (!result.success) {
          logger.error(
            { errors: result.error.format() },
            "Environment validation failed",
          );
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
