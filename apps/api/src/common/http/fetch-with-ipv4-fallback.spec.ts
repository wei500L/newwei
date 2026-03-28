jest.mock("node:https", () => ({
  request: jest.fn(),
}));

import { EventEmitter } from "node:events";
import { request as httpsRequest } from "node:https";

import { fetchWithIpv4Fallback } from "./fetch-with-ipv4-fallback";

describe("fetchWithIpv4Fallback", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("retries configured hosts with an ipv4 request after undici connect timeouts", async () => {
    const networkError = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    jest.spyOn(global, "fetch").mockRejectedValue(networkError);

    const httpsRequestMock = httpsRequest as unknown as jest.Mock;
    httpsRequestMock.mockImplementation(
      (
        _url: URL,
        _options: Record<string, unknown>,
        callback: (response: EventEmitter & {
          statusCode?: number;
          statusMessage?: string;
          headers: Record<string, string>;
        }) => void,
      ) => {
        const request = new EventEmitter() as EventEmitter & {
          destroy: (error?: Error) => void;
          end: () => void;
          setTimeout: (ms: number, listener: () => void) => void;
          write: (chunk: string | Buffer | Uint8Array) => void;
        };

        request.destroy = jest.fn(() => {
          request.emit("close");
        });
        request.write = jest.fn();
        request.setTimeout = jest.fn();
        request.end = () => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode?: number;
            statusMessage?: string;
            headers: Record<string, string>;
          };
          response.statusCode = 200;
          response.statusMessage = "OK";
          response.headers = { "content-type": "application/json" };
          callback(response);
          response.emit("data", Buffer.from('{"articles":[]}'));
          response.emit("end");
          request.emit("close");
        };

        return request;
      },
    );

    const response = await fetchWithIpv4Fallback(
      "https://api.gdeltproject.org/api/v2/doc/doc?query=test",
      {
        headers: { accept: "application/json" },
      },
      { timeoutMs: 15_000 },
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.gdeltproject.org/api/v2/doc/doc?query=test",
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(httpsRequestMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        family: 4,
        headers: { accept: "application/json" },
        method: "GET",
      }),
      expect.any(Function),
    );
    await expect(response.json()).resolves.toEqual({ articles: [] });
  });

  it("rethrows fetch errors for hosts without ipv4 fallback", async () => {
    const networkError = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    jest.spyOn(global, "fetch").mockRejectedValue(networkError);

    await expect(
      fetchWithIpv4Fallback("https://example.com/feed.json", {}),
    ).rejects.toBe(networkError);
  });

  it("retries configured hosts when the primary fetch attempt times out", async () => {
    const timeoutError = new Error("This operation was aborted");
    timeoutError.name = "AbortError";
    jest.spyOn(global, "fetch").mockRejectedValue(timeoutError);

    const httpsRequestMock = httpsRequest as unknown as jest.Mock;
    httpsRequestMock.mockImplementation(
      (
        _url: URL,
        _options: Record<string, unknown>,
        callback: (response: EventEmitter & {
          statusCode?: number;
          statusMessage?: string;
          headers: Record<string, string>;
        }) => void,
      ) => {
        const request = new EventEmitter() as EventEmitter & {
          destroy: (error?: Error) => void;
          end: () => void;
          setTimeout: (ms: number, listener: () => void) => void;
          write: (chunk: string | Buffer | Uint8Array) => void;
        };

        request.destroy = jest.fn(() => {
          request.emit("close");
        });
        request.write = jest.fn();
        request.setTimeout = jest.fn();
        request.end = () => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode?: number;
            statusMessage?: string;
            headers: Record<string, string>;
          };
          response.statusCode = 200;
          response.statusMessage = "OK";
          response.headers = { "content-type": "application/json" };
          callback(response);
          response.emit("data", Buffer.from('{"articles":[{"title":"Recovered"}]}'));
          response.emit("end");
          request.emit("close");
        };

        return request;
      },
    );

    const response = await fetchWithIpv4Fallback(
      "https://api.gdeltproject.org/api/v2/doc/doc?query=test",
      {},
      { timeoutMs: 12_000 },
    );

    await expect(response.json()).resolves.toEqual({
      articles: [{ title: "Recovered" }],
    });
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });
});
