import { baseEnvSchema, strongSecretSchema } from "@modular/utils";

const validBaseEnv = {
  MONGO_URI: "mongodb://root:secret@localhost:27017/app",
  REDIS_HOST: "localhost",
  REDIS_PORT: "6379",
  SMTP_USER: "test@example.com",
  SMTP_PASS: "test",
  JWT_SECRET: "a".repeat(48),
  NEXTAUTH_SECRET: "b".repeat(48),
  NEXTAUTH_URL: "http://localhost:3000",
  API_BASE_URL: "http://localhost:4000",
  CRAWL4AI_BASE_URL: "http://localhost:8082",
};

describe("strongSecretSchema", () => {
  it("rejects the known placeholder used in sample env files", () => {
    const result = strongSecretSchema.safeParse(
      "change_me_please_replace_32_chars",
    );
    expect(result.success).toBe(false);
  });

  it("rejects short secrets", () => {
    expect(strongSecretSchema.safeParse("short-secret").success).toBe(false);
  });

  it("rejects dev-prefixed and plain 'secret' values", () => {
    expect(strongSecretSchema.safeParse("dev-secret-12345678").success).toBe(
      false,
    );
    expect(strongSecretSchema.safeParse("secret").success).toBe(false);
  });

  it("accepts a 32+ char random secret", () => {
    expect(strongSecretSchema.safeParse("a".repeat(64)).success).toBe(true);
  });
});

describe("baseEnvSchema JWT/NextAuth secrets", () => {
  it("fails when JWT_SECRET is the known placeholder", () => {
    const result = baseEnvSchema.safeParse({
      ...validBaseEnv,
      JWT_SECRET: "change_me_please_replace_32_chars",
    });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.flatten().fieldErrors.JWT_SECRET)
      .toBeTruthy();
  });

  it("fails when NEXTAUTH_SECRET is the known placeholder", () => {
    const result = baseEnvSchema.safeParse({
      ...validBaseEnv,
      NEXTAUTH_SECRET: "change_me_please_replace_32_chars",
    });
    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.flatten().fieldErrors.NEXTAUTH_SECRET,
    ).toBeTruthy();
  });

  it("accepts valid 32+ char secrets", () => {
    const result = baseEnvSchema.safeParse(validBaseEnv);
    expect(result.success).toBe(true);
  });
});
