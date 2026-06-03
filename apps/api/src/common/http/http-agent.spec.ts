import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

import { createKeepAliveAgentOptions, withKeepAliveAgents } from "./http-agent";

describe("http keep-alive agent helpers", () => {
  it("returns no agents when keep-alive is disabled", () => {
    expect(
      createKeepAliveAgentOptions({
        keepAliveEnabled: false,
        maxSockets: 64,
        maxFreeSockets: 16,
        timeoutMs: 60_000,
      }),
    ).toEqual({});
  });

  it("creates bounded http and https agents when enabled", () => {
    const options = createKeepAliveAgentOptions({
      keepAliveEnabled: true,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeoutMs: 60_000,
    });

    expect(options.httpAgent).toBeInstanceOf(HttpAgent);
    expect(options.httpsAgent).toBeInstanceOf(HttpsAgent);
    expect(options.httpAgent?.options.keepAlive).toBe(true);
    expect(options.httpAgent?.maxSockets).toBe(64);
    expect(options.httpAgent?.maxFreeSockets).toBe(16);
  });

  it("merges agents into existing module options", () => {
    const options = withKeepAliveAgents(
      { timeout: 1234 },
      {
        keepAliveEnabled: true,
        maxSockets: 64,
        maxFreeSockets: 16,
        timeoutMs: 60_000,
      },
    );

    expect(options.timeout).toBe(1234);
    expect(options.httpAgent).toBeInstanceOf(HttpAgent);
    expect(options.httpsAgent).toBeInstanceOf(HttpsAgent);
  });
});
