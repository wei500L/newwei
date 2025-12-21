import { z } from "zod";

import { logServerError } from "./server-logger";

const publicSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.string().url()
});

const serverSchema = z.object({
  API_BASE_URL: z.string().url().optional()
});

const isServer = typeof window === "undefined";

const publicParsed = publicSchema.safeParse({
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL
});

if (!publicParsed.success) {
  const fieldErrors = publicParsed.error.flatten().fieldErrors;
  if (isServer) {
    logServerError("Invalid web environment configuration", publicParsed.error, {
      meta: fieldErrors
    });
  } else {
    // eslint-disable-next-line no-console
    console.error("Invalid web environment configuration", fieldErrors);
  }
  throw new Error("Invalid web environment configuration");
}

const publicEnvValues = publicParsed.data;

const serverParsed = isServer
  ? serverSchema.safeParse({
      API_BASE_URL: process.env.API_BASE_URL
    })
  : null;

if (isServer && serverParsed && !serverParsed.success) {
  const fieldErrors = serverParsed.error.flatten().fieldErrors;
  logServerError("Invalid web environment configuration", serverParsed.error, {
    meta: fieldErrors
  });
  throw new Error("Invalid web environment configuration");
}

const publicApiBaseUrl = publicEnvValues.NEXT_PUBLIC_API_BASE_URL.endsWith("/api")
  ? publicEnvValues.NEXT_PUBLIC_API_BASE_URL
  : `${publicEnvValues.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "")}/api`;
const publicApiRoot = publicApiBaseUrl.endsWith("/api") ? publicApiBaseUrl.slice(0, -4) : publicApiBaseUrl;

const internalApiRootRaw =
  isServer && serverParsed && serverParsed.success ? serverParsed.data.API_BASE_URL ?? publicApiRoot : publicApiRoot;
const internalApiBaseUrl = internalApiRootRaw.endsWith("/api")
  ? internalApiRootRaw
  : `${internalApiRootRaw.replace(/\/$/, "")}/api`;
const internalApiRoot = internalApiBaseUrl.endsWith("/api") ? internalApiBaseUrl.slice(0, -4) : internalApiBaseUrl;

const apiBaseUrl = typeof window === "undefined" ? internalApiBaseUrl : publicApiBaseUrl;
const apiRoot = typeof window === "undefined" ? internalApiRoot : publicApiRoot;
const graphqlUrl = `${apiRoot}/graphql`;

export const env = {
  ...publicEnvValues,
  apiBaseUrl,
  apiRoot,
  graphqlUrl
};
