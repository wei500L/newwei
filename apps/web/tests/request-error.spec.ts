import { describe, expect, it } from "vitest";

import { classifyRequestError } from "../lib/request-error";

describe("classifyRequestError", () => {
  it("classifies axios network errors when no response is present", () => {
    const err = { isAxiosError: true } as unknown;
    expect(classifyRequestError(err)).toEqual({ kind: "network" });
  });

  it("classifies axios permission errors (403)", () => {
    const err403 = { isAxiosError: true, response: { status: 403 } } as unknown;
    expect(classifyRequestError(err403)).toEqual({ kind: "permission", status: 403 });
  });

  it("classifies axios auth errors (401)", () => {
    const err401 = { isAxiosError: true, response: { status: 401 } } as unknown;
    expect(classifyRequestError(err401)).toEqual({ kind: "auth", status: 401 });
  });

  it("classifies axios 5xx as service errors", () => {
    const err502 = { isAxiosError: true, response: { status: 502 } } as unknown;
    expect(classifyRequestError(err502)).toEqual({ kind: "service", status: 502 });
  });

  it("classifies axios 404 as notFound errors", () => {
    const err404 = { isAxiosError: true, response: { status: 404 } } as unknown;
    expect(classifyRequestError(err404)).toEqual({ kind: "notFound", status: 404 });
  });

  it("classifies axios 429 as rateLimit errors", () => {
    const err429 = { isAxiosError: true, response: { status: 429 } } as unknown;
    expect(classifyRequestError(err429)).toEqual({ kind: "rateLimit", status: 429 });
  });

  it("classifies axios timeouts by error.code/message", () => {
    const timeout = { isAxiosError: true, code: "ECONNABORTED", message: "timeout" } as unknown;
    expect(classifyRequestError(timeout)).toEqual({ kind: "timeout", code: "ECONNABORTED" });
  });

  it("classifies Apollo network errors by statusCode/response.status", () => {
    const err401 = { networkError: { statusCode: 401 } } as unknown;
    expect(classifyRequestError(err401)).toEqual({ kind: "auth", status: 401 });

    const err500 = { networkError: { response: { status: 500 } } } as unknown;
    expect(classifyRequestError(err500)).toEqual({ kind: "service", status: 500 });
  });

  it("classifies Apollo graphQLErrors by extensions.code", () => {
    const unauthenticated = {
      graphQLErrors: [{ extensions: { code: "UNAUTHENTICATED" } }]
    } as unknown;
    expect(classifyRequestError(unauthenticated)).toEqual({ kind: "auth", code: "UNAUTHENTICATED" });

    const forbidden = { graphQLErrors: [{ extensions: { code: "FORBIDDEN" } }] } as unknown;
    expect(classifyRequestError(forbidden)).toEqual({ kind: "permission", code: "FORBIDDEN" });

    const badInput = { graphQLErrors: [{ extensions: { code: "BAD_USER_INPUT" } }] } as unknown;
    expect(classifyRequestError(badInput)).toEqual({ kind: "validation", code: "BAD_USER_INPUT" });

    const notFound = { graphQLErrors: [{ extensions: { code: "NOT_FOUND" } }] } as unknown;
    expect(classifyRequestError(notFound)).toEqual({ kind: "notFound", code: "NOT_FOUND" });

    const rateLimited = { graphQLErrors: [{ extensions: { code: "RATE_LIMITED" } }] } as unknown;
    expect(classifyRequestError(rateLimited)).toEqual({ kind: "rateLimit", code: "RATE_LIMITED" });

    const internal = {
      graphQLErrors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }]
    } as unknown;
    expect(classifyRequestError(internal)).toEqual({ kind: "service", code: "INTERNAL_SERVER_ERROR" });
  });

  it("classifies AbortError as cancelled", () => {
    const err = new DOMException("Aborted", "AbortError");
    expect(classifyRequestError(err)).toEqual({ kind: "cancelled" });
  });

  it("falls back to message heuristics for generic Errors", () => {
    expect(classifyRequestError(new Error("Failed to fetch"))).toEqual({ kind: "network" });
    expect(classifyRequestError(new Error("Request timed out"))).toEqual({ kind: "timeout" });
  });
});
