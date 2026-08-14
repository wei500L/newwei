import "server-only";

import { strongSecretSchema } from "@modular/utils";
import { z } from "zod";

import { env } from "./env";
import { logServerError } from "./server-logger";

const serverSchema = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: strongSecretSchema
});

type ServerEnv = typeof env & z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

function loadServerEnv(): ServerEnv {
  if (cached) {
    return cached;
  }

  const parsed = serverSchema.safeParse({
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET
  });

  if (!parsed.success) {
    logServerError("Invalid web environment configuration", parsed.error, {
      meta: parsed.error.flatten().fieldErrors
    });
    throw new Error("Invalid web environment configuration");
  }

  cached = {
    ...env,
    ...parsed.data
  };
  return cached;
}

export const serverEnv: ServerEnv = new Proxy({} as ServerEnv, {
  get(_target, property, receiver) {
    return Reflect.get(loadServerEnv(), property, receiver);
  }
});
