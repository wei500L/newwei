import { Global, Module } from "@nestjs/common";
import { ConfigModule as NestConfigModule } from "@nestjs/config";
import { apiEnvSchema } from "./env.schema";
import { EnvService } from "./config.service";
import { createLogger } from "@modular/utils";

const logger = createLogger({ name: "api-config" });

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (config) => {
        const result = apiEnvSchema.safeParse(config);
        if (!result.success) {
          const formatted = result.error.format();
          logger.error({ errors: formatted }, "Environment validation failed");
          throw new Error("Invalid environment configuration");
        }
        return result.data;
      }
    })
  ],
  providers: [EnvService],
  exports: [EnvService]
})
export class ConfigModule {}
