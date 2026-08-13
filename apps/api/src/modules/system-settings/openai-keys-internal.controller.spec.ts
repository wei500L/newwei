import { OpenAiKeysInternalController } from "./openai-keys-internal.controller";

describe("OpenAiKeysInternalController", () => {
  const openaiKeys = {
    getPlaintextKeys: jest.fn(),
    reportAppliedKeyFingerprints: jest.fn(),
  } as const;
  const proxyLoadBalancing = {
    getInternalSnapshot: jest.fn(),
  } as const;

  let controller: OpenAiKeysInternalController;

  beforeEach(() => {
    jest.resetAllMocks();
    openaiKeys.getPlaintextKeys.mockResolvedValue(["sk-one", "sk-two"]);
    openaiKeys.reportAppliedKeyFingerprints.mockResolvedValue(undefined);
    proxyLoadBalancing.getInternalSnapshot.mockResolvedValue({
      snapshot: true,
    });
    controller = new OpenAiKeysInternalController(
      openaiKeys as any,
      proxyLoadBalancing as any,
    );
  });

  it("returns only the openaiApiKeys structure and fetches keys once", async () => {
    const result = await controller.getOpenAiKeys({
      ip: "10.0.0.5",
      headers: {},
    } as any);

    expect(openaiKeys.getPlaintextKeys).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ openaiApiKeys: ["sk-one", "sk-two"] });
  });

  it("reports applied key fingerprints", async () => {
    const result = await controller.reportAppliedOpenAiKeys({
      source: "db",
      keyFingerprints: ["a", "b"],
    } as any);

    expect(openaiKeys.reportAppliedKeyFingerprints).toHaveBeenCalledWith({
      source: "db",
      keyFingerprints: ["a", "b"],
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns the proxy load-balancing snapshot", async () => {
    const result = await controller.getProxyLoadBalancingSnapshot();

    expect(proxyLoadBalancing.getInternalSnapshot).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ snapshot: true });
  });
});
