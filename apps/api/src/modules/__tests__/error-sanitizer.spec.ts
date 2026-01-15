import { sanitizeError, redactSensitiveFields } from "@modular/utils";

describe("error-sanitizer", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe("sanitizeError", () => {
    describe("production mode", () => {
      beforeEach(() => {
        process.env.NODE_ENV = "production";
      });

      it("removes stack trace in production mode", () => {
        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at test.js:1:1";

        const result = sanitizeError(error);

        expect(result.message).toBe("Test error");
        expect(result.name).toBe("Error");
        expect(result.stack).toBeUndefined();
      });

      it("preserves stack trace when includeStack option is true", () => {
        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at test.js:1:1";

        const result = sanitizeError(error, { includeStack: true });

        expect(result.stack).toBe(error.stack);
      });

      it("redacts sensitive password patterns", () => {
        const error = new Error("Connection failed: password=secret123");

        const result = sanitizeError(error);

        expect(result.message).toBe("Connection failed: password=[REDACTED]");
      });

      it("redacts sensitive token patterns", () => {
        const error = new Error("Auth failed: token=abc123xyz");

        const result = sanitizeError(error);

        expect(result.message).toBe("Auth failed: token=[REDACTED]");
      });

      it("redacts sensitive apiKey patterns", () => {
        const error = new Error("Request failed: apiKey=sk-12345");

        const result = sanitizeError(error);

        expect(result.message).toBe("Request failed: apiKey=[REDACTED]");
      });

      it("redacts sensitive api_key patterns", () => {
        const error = new Error("Request failed: api_key=sk-12345");

        const result = sanitizeError(error);

        expect(result.message).toBe("Request failed: api_key=[REDACTED]");
      });

      it("redacts sensitive secret patterns", () => {
        const error = new Error("Config error: secret=mysecretvalue");

        const result = sanitizeError(error);

        expect(result.message).toBe("Config error: secret=[REDACTED]");
      });

      it("redacts Bearer token patterns", () => {
        const error = new Error("Auth header: Bearer eyJhbGciOiJIUzI1NiJ9.test");

        const result = sanitizeError(error);

        expect(result.message).toBe("Auth header: Bearer [REDACTED]");
      });

      it("redacts Basic auth patterns", () => {
        const error = new Error("Auth header: Basic dXNlcjpwYXNz");

        const result = sanitizeError(error);

        expect(result.message).toBe("Auth header: Basic [REDACTED]");
      });
    });

    describe("development mode", () => {
      beforeEach(() => {
        process.env.NODE_ENV = "development";
      });

      it("preserves stack trace in development mode", () => {
        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at test.js:1:1";

        const result = sanitizeError(error);

        expect(result.message).toBe("Test error");
        expect(result.name).toBe("Error");
        expect(result.stack).toBe(error.stack);
      });

      it("still redacts sensitive patterns by default", () => {
        const error = new Error("password=secret123");

        const result = sanitizeError(error);

        expect(result.message).toBe("password=[REDACTED]");
      });

      it("skips redaction when redactSensitive is false", () => {
        const error = new Error("password=secret123");

        const result = sanitizeError(error, { redactSensitive: false });

        expect(result.message).toBe("password=secret123");
      });
    });

    describe("forceProduction option", () => {
      beforeEach(() => {
        process.env.NODE_ENV = "development";
      });

      it("removes stack when forceProduction is true", () => {
        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at test.js:1:1";

        const result = sanitizeError(error, { forceProduction: true });

        expect(result.stack).toBeUndefined();
      });

      it("preserves stack when forceProduction is false in production", () => {
        process.env.NODE_ENV = "production";
        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at test.js:1:1";

        const result = sanitizeError(error, { forceProduction: false });

        expect(result.stack).toBe(error.stack);
      });
    });

    describe("non-Error inputs", () => {
      it("handles string input", () => {
        const result = sanitizeError("string error");

        expect(result.message).toBe("string error");
        expect(result.name).toBeUndefined();
        expect(result.stack).toBeUndefined();
      });

      it("handles null input", () => {
        const result = sanitizeError(null);

        expect(result.message).toBe("Unknown error");
      });

      it("handles undefined input", () => {
        const result = sanitizeError(undefined);

        expect(result.message).toBe("Unknown error");
      });

      it("handles number input", () => {
        const result = sanitizeError(404);

        expect(result.message).toBe("404");
      });

      it("handles object input", () => {
        const result = sanitizeError({ code: "ERR_001" });

        expect(result.message).toBe("[object Object]");
      });

      it("redacts sensitive data in string input", () => {
        const result = sanitizeError("Failed with password=secret");

        expect(result.message).toBe("Failed with password=[REDACTED]");
      });
    });

    describe("status code preservation", () => {
      it("preserves status code from error with status property", () => {
        const error = new Error("Not found") as Error & { status: number };
        error.status = 404;

        const result = sanitizeError(error);

        expect(result.status).toBe(404);
      });

      it("does not include status when not present", () => {
        const error = new Error("Generic error");

        const result = sanitizeError(error);

        expect(result.status).toBeUndefined();
      });
    });

    describe("empty message handling", () => {
      it("handles error with empty message", () => {
        const error = new Error("");

        const result = sanitizeError(error);

        expect(result.message).toBe("Unknown error");
      });
    });
  });

  describe("redactSensitiveFields", () => {
    it("redacts password with equals sign", () => {
      const result = redactSensitiveFields("password=secret123");
      expect(result).toBe("password=[REDACTED]");
    });

    it("redacts password with colon", () => {
      const result = redactSensitiveFields("password: secret123");
      expect(result).toBe("password:[REDACTED]");
    });

    it("redacts quoted values", () => {
      const result = redactSensitiveFields('password="secret123"');
      expect(result).toBe("password=[REDACTED]");
    });

    it("redacts multiple sensitive fields", () => {
      const result = redactSensitiveFields("password=abc token=xyz");
      expect(result).toBe("password=[REDACTED] token=[REDACTED]");
    });

    it("handles empty string", () => {
      const result = redactSensitiveFields("");
      expect(result).toBe("");
    });

    it("handles null input", () => {
      const result = redactSensitiveFields(null as unknown as string);
      expect(result).toBe(null);
    });

    it("handles undefined input", () => {
      const result = redactSensitiveFields(undefined as unknown as string);
      expect(result).toBe(undefined);
    });

    it("preserves non-sensitive content", () => {
      const result = redactSensitiveFields("Connection to database failed");
      expect(result).toBe("Connection to database failed");
    });

    it("is case insensitive", () => {
      const result = redactSensitiveFields("PASSWORD=secret TOKEN=abc");
      expect(result).toBe("PASSWORD=[REDACTED] TOKEN=[REDACTED]");
    });

    it("redacts credential patterns", () => {
      const result = redactSensitiveFields("credential=myCredential");
      expect(result).toBe("credential=[REDACTED]");
    });

    it("redacts auth patterns", () => {
      const result = redactSensitiveFields("auth=myAuthToken");
      expect(result).toBe("auth=[REDACTED]");
    });
  });
});
