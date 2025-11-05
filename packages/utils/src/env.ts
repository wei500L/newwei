import { config as loadDotenv } from "dotenv";
import { z } from "zod";

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MYSQL_HOST: z.string().min(1),
  MYSQL_PORT: z.coerce.number().int().positive(),
  MYSQL_USER: z.string().min(1),
  MYSQL_PASSWORD: z.string().min(1),
  MYSQL_DB: z.string().min(1),
  MONGO_URI: z.string().url().or(z.string().regex(/^mongodb/)),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  JWT_SECRET: z.string().min(16),
  NEXTAUTH_SECRET: z.string().min(16),
  NEXTAUTH_URL: z.string().url(),
  API_BASE_URL: z.string().url()
});

export type BaseEnvSchema = typeof baseEnvSchema;
export type BaseEnv = z.infer<typeof baseEnvSchema>;

export interface LoadEnvOptions {
  dotenvPath?: string;
  overrideProcessEnv?: boolean;
}

export function loadAndValidateEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  options: LoadEnvOptions = {}
): z.infer<TSchema> {
  if (options.dotenvPath) {
    loadDotenv({ path: options.dotenvPath });
  } else {
    loadDotenv();
  }

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // TODO(app): wire this into centralized structured logger once tracing pipeline is available.
    console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
    throw new Error("Environment validation failed");
  }

  if (options.overrideProcessEnv) {
    Object.assign(process.env, parsed.data);
  }

  return parsed.data;
}
