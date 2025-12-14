import { z } from "zod";
import { logServerError } from "./server-logger";

const schema = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16),
  NEXT_PUBLIC_API_BASE_URL: z.string().url(),
  API_BASE_URL: z.string().url().optional()
});

const parsed = schema.safeParse({
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  API_BASE_URL: process.env.API_BASE_URL
});

if (!parsed.success) {
  logServerError("Invalid web environment configuration", parsed.error, {
    meta: parsed.error.flatten().fieldErrors
  });
  throw new Error("Invalid web environment configuration");
}

const envValues = parsed.data;

const publicApiBaseUrl = envValues.NEXT_PUBLIC_API_BASE_URL.endsWith("/api")
  ? envValues.NEXT_PUBLIC_API_BASE_URL
  : `${envValues.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "")}/api`;
const publicApiRoot = publicApiBaseUrl.endsWith("/api") ? publicApiBaseUrl.slice(0, -4) : publicApiBaseUrl;

const internalApiRootRaw = envValues.API_BASE_URL ?? publicApiRoot;
const internalApiBaseUrl = internalApiRootRaw.endsWith("/api")
  ? internalApiRootRaw
  : `${internalApiRootRaw.replace(/\/$/, "")}/api`;
const internalApiRoot = internalApiBaseUrl.endsWith("/api") ? internalApiBaseUrl.slice(0, -4) : internalApiBaseUrl;

const apiBaseUrl = typeof window === "undefined" ? internalApiBaseUrl : publicApiBaseUrl;
const apiRoot = typeof window === "undefined" ? internalApiRoot : publicApiRoot;
const graphqlUrl = `${apiRoot}/graphql`;

export const env = {
  ...envValues,
  apiBaseUrl,
  apiRoot,
  graphqlUrl
};
