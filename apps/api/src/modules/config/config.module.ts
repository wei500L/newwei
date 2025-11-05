import { Global, Module } from "@nestjs/common";
import { ConfigModule as NestConfigModule } from "@nestjs/config";
import { apiEnvSchema } from "./env.schema";
import { EnvService } from "./config.service";

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
          console.error("Environment validation failed", formatted);
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
