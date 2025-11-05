import { z } from "zod";

const schema = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16),
  API_BASE_URL: z.string().url(),
  NEXT_PUBLIC_API_BASE_URL: z.string().url().optional()
});

const parsed = schema.safeParse({
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  API_BASE_URL: process.env.API_BASE_URL,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL
});

if (!parsed.success) {
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Invalid web environment configuration");
}

const envValues = parsed.data;

const baseUrl = envValues.NEXT_PUBLIC_API_BASE_URL ?? envValues.API_BASE_URL;
const apiBaseUrl = baseUrl.endsWith("/api") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/api`;
const apiRoot = apiBaseUrl.endsWith("/api") ? apiBaseUrl.slice(0, -4) : apiBaseUrl;
const graphqlUrl = `${apiRoot}/graphql`;

export const env = {
  ...envValues,
  apiBaseUrl,
  graphqlUrl
};
