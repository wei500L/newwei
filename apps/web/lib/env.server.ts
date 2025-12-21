import "server-only";

import { z } from "zod";

import { env } from "./env";
import { logServerError } from "./server-logger";

const serverSchema = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16)
});

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

export const serverEnv = {
  ...env,
  ...parsed.data
};

