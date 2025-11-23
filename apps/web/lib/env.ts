import { z } from "zod";

const schema = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16),
  NEXT_PUBLIC_API_BASE_URL: z.string().url()
});

const parsed = schema.safeParse({
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL
});

if (!parsed.success) {
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Invalid web environment configuration");
}

const envValues = parsed.data;

const apiBaseUrl = envValues.NEXT_PUBLIC_API_BASE_URL.endsWith("/api")
  ? envValues.NEXT_PUBLIC_API_BASE_URL
  : `${envValues.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "")}/api`;
const apiRoot = apiBaseUrl.endsWith("/api") ? apiBaseUrl.slice(0, -4) : apiBaseUrl;
const graphqlUrl = `${apiRoot}/graphql`;

export const env = {
  ...envValues,
  apiBaseUrl,
  apiRoot,
  graphqlUrl
};
