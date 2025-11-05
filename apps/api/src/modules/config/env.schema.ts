import { baseEnvSchema } from "@modular/utils";
import { z } from "zod";

export const apiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  JWT_ISSUER: z.string().default("modular-monolith"),
  JWT_AUDIENCE: z.string().default("modular-monolith-clients"),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  REDIS_USERNAME: z.string().optional(),
  BULLMQ_NAMESPACE: z.string().default("modular"),
  RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW: z.coerce.number().int().positive().default(60),
  GRAPHQL_PLAYGROUND: z.coerce.boolean().default(
    process.env.NODE_ENV === "production" ? false : true
  ),
  GRAPHQL_INTROSPECTION: z.coerce.boolean().default(
    process.env.NODE_ENV === "production" ? false : true
  ),
  GRAPHQL_DEPTH_LIMIT: z.coerce.number().int().positive().default(8),
  GRAPHQL_COMPLEXITY_LIMIT: z.coerce.number().int().positive().default(2000),
  CORS_ORIGIN: z.string().optional()
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
