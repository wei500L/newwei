import { VectorClientService } from "./vector-client.service";

describe("VectorClientService diagnostics", () => {
  it("returns a redacted runtime snapshot", async () => {
    const settings = {
      getPublicSettings: jest.fn().mockResolvedValue({
        source: "db",
        enabled: true,
        fallbackToMongo: false,
        baseUrl: "https://vector.internal",
        timeoutMs: 8000,
        maxRetries: 3,
        hasToken: true,
        tokenSource: "stored",
      }),
      getEffectiveConfig: jest.fn().mockResolvedValue({
        enabled: true,
        fallbackToMongo: false,
        baseUrl: "https://vector.internal",
        token: "secret-token",
        timeoutMs: 8000,
        maxRetries: 3,
      }),
    } as any;

    const service = new VectorClientService(settings);
    (service as any).consecutiveFailures = 2;
    (service as any).unavailableUntilMs = Date.now() + 5_000;
    (service as any).lastOperation = "search";
    (service as any).lastFailureAtMs = Date.now() - 2_000;
    (service as any).lastErrorName = "VectorBadResponseError";
    (service as any).lastErrorMessage = "Bad gateway";

    const diagnostics = await service.getDiagnostics();

    expect(diagnostics.source).toBe("db");
    expect(diagnostics.configured).toBe(true);
    expect(diagnostics.temporarilyUnavailable).toBe(true);
    expect(diagnostics.tokenSource).toBe("stored");
    expect(diagnostics.lastOperation).toBe("search");
    expect(diagnostics.lastErrorMessage).toBe("Bad gateway");
    expect((diagnostics as any).token).toBeUndefined();
  });
});
