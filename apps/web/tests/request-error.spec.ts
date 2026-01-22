import { describe, expect, it } from "vitest";

import { classifyRequestError } from "../lib/request-error";

describe("classifyRequestError", () => {
  it("classifies axios network errors when no response is present", () => {
    const err = { isAxiosError: true } as unknown;
    expect(classifyRequestError(err)).toEqual({ kind: "network" });
  });

  it("classifies axios permission errors (401/403)", () => {
    const err403 = { isAxiosError: true, response: { status: 403 } } as unknown;
    expect(classifyRequestError(err403)).toEqual({ kind: "permission", status: 403 });
  });

  it("classifies axios 5xx as service errors", () => {
    const err502 = { isAxiosError: true, response: { status: 502 } } as unknown;
    expect(classifyRequestError(err502)).toEqual({ kind: "service", status: 502 });
  });

  it("classifies Apollo network errors by statusCode/response.status", () => {
    const err401 = { networkError: { statusCode: 401 } } as unknown;
    expect(classifyRequestError(err401)).toEqual({ kind: "permission", status: 401 });

    const err500 = { networkError: { response: { status: 500 } } } as unknown;
    expect(classifyRequestError(err500)).toEqual({ kind: "service", status: 500 });
  });

  it("classifies Apollo graphQLErrors by extensions.code", () => {
    const forbidden = { graphQLErrors: [{ extensions: { code: "FORBIDDEN" } }] } as unknown;
    expect(classifyRequestError(forbidden)).toEqual({ kind: "permission" });

    const internal = {
      graphQLErrors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }]
    } as unknown;
    expect(classifyRequestError(internal)).toEqual({ kind: "service" });
  });

  it("falls back to message heuristics for generic Errors", () => {
    expect(classifyRequestError(new Error("Failed to fetch"))).toEqual({ kind: "network" });
  });
});

