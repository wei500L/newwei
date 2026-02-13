import {
  detectOpenAiCompatibilityIssue,
  sanitizeUpstreamErrorText,
} from "./llm-openai-compat";

describe("llm-openai-compat", () => {
  describe("sanitizeUpstreamErrorText", () => {
    it("redacts bearer and sk tokens and truncates long text", () => {
      const raw =
        "Authorization failed for Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789 and sk-abcdefghijklmnopqrstuvwxyz0123456789";

      const sanitized = sanitizeUpstreamErrorText(raw, { maxLength: 40 });

      expect(sanitized).toContain("Bearer [REDACTED]");
      expect(sanitized).toContain("sk-[REDACTED]");
      expect(sanitized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
      expect(sanitized.length).toBeLessThanOrEqual(64);
    });
  });

  describe("detectOpenAiCompatibilityIssue", () => {
    it("detects unsupported metadata from unrecognized argument errors", () => {
      const issue = detectOpenAiCompatibilityIssue({
        status: 400,
        apiSurface: "chat_completions",
        errorText: "Unrecognized request argument supplied: metadata",
      });

      expect(issue?.code).toBe("UNSUPPORTED_METADATA");
      expect(issue?.incompatibleField).toBe("metadata");
    });

    it("does not classify generic invalid metadata value as unsupported metadata", () => {
      const issue = detectOpenAiCompatibilityIssue({
        status: 400,
        apiSurface: "chat_completions",
        errorText: "Invalid metadata value: expected object but got string",
      });

      expect(issue).toBeNull();
    });

    it("detects unsupported responses api only when responses endpoint is referenced", () => {
      const issue = detectOpenAiCompatibilityIssue({
        status: 405,
        apiSurface: "responses",
        errorText: "Method not allowed for /v1/responses",
      });

      expect(issue?.code).toBe("RESPONSES_API_UNSUPPORTED");
      expect(issue?.incompatibleField).toBe("apiSurface");
    });

    it("detects unsupported responses api for 400 unknown route style errors", () => {
      const issue = detectOpenAiCompatibilityIssue({
        status: 400,
        apiSurface: "responses",
        errorText: "Unknown route: POST /v1/responses",
      });

      expect(issue?.code).toBe("RESPONSES_API_UNSUPPORTED");
      expect(issue?.incompatibleField).toBe("apiSurface");
    });

    it("does not classify non-responses 405 errors as responses api unsupported", () => {
      const issue = detectOpenAiCompatibilityIssue({
        status: 405,
        apiSurface: "responses",
        errorText: "Method not allowed for /v1/chat/completions",
      });

      expect(issue).toBeNull();
    });

    it("keeps metadata incompatibility classification for non-route responses 400 errors", () => {
      const issue = detectOpenAiCompatibilityIssue({
        status: 400,
        apiSurface: "responses",
        errorText: "Invalid parameter metadata on /v1/responses",
      });

      expect(issue?.code).toBe("UNSUPPORTED_METADATA");
      expect(issue?.incompatibleField).toBe("metadata");
    });

    it("detects invalid message content shape hints", () => {
      const issue = detectOpenAiCompatibilityIssue({
        status: 400,
        apiSurface: "chat_completions",
        errorText: "messages[0].content must be a string",
      });

      expect(issue?.code).toBe("INVALID_MESSAGE_CONTENT");
      expect(issue?.incompatibleField).toBe("messages[].content");
    });
  });
});
