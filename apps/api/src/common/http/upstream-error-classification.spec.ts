import {
  classifyUpstreamRequestError,
  readHttpStatus,
  readNestedErrorCode,
} from "./upstream-error-classification";

describe("upstream error classification", () => {
  it("reads nested error codes through cause chains", () => {
    expect(
      readNestedErrorCode({
        cause: {
          cause: {
            code: "ENOTFOUND",
          },
        },
      }),
    ).toBe("ENOTFOUND");
  });

  it("prefers HTTP status classification when available", () => {
    expect(readHttpStatus({ status: 429 })).toBe(429);
    expect(classifyUpstreamRequestError({ status: 429 })).toBe(
      "upstream_rate_limited",
    );
  });

  it("classifies timeout and DNS failures without source-specific logic", () => {
    expect(
      classifyUpstreamRequestError(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ENOTFOUND" },
        }),
      ),
    ).toBe("dns_resolution_failed");

    expect(
      classifyUpstreamRequestError(
        Object.assign(new Error("socket timed out"), {
          cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
        }),
      ),
    ).toBe("request_timeout");
  });
});
