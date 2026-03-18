import { describe, expect, it } from "vitest";

import { applyRealtimeSignalsSecretFields } from "../lib/realtime-signals-settings-payload";

describe("applyRealtimeSignalsSecretFields", () => {
  it("keeps untouched empty secret fields out of payload", () => {
    const payload: Record<string, unknown> = {};
    applyRealtimeSignalsSecretFields(
      payload,
      {
        aisRelaySharedSecret: "",
        openskyClientSecret: "",
        acledOauthPassword: "   ",
      },
      {
        aisRelaySharedSecret: false,
        openskyClientSecret: false,
        acledOauthPassword: false,
      },
    );
    expect(payload).toEqual({});
  });

  it("sends explicit null when a secret field was touched and cleared", () => {
    const payload: Record<string, unknown> = {};
    applyRealtimeSignalsSecretFields(
      payload,
      {
        aisRelaySharedSecret: "",
        openskyClientSecret: "   ",
        acledOauthPassword: "",
      },
      {
        aisRelaySharedSecret: true,
        openskyClientSecret: true,
        acledOauthPassword: true,
      },
    );
    expect(payload).toEqual({
      aisRelaySharedSecret: null,
      openskyClientSecret: null,
      acledOauthPassword: null,
    });
  });

  it("sends trimmed non-empty secret values", () => {
    const payload: Record<string, unknown> = {};
    applyRealtimeSignalsSecretFields(
      payload,
      {
        aisRelaySharedSecret: "  relay-secret  ",
        openskyClientSecret: "  secret-1  ",
      },
      {
        aisRelaySharedSecret: true,
        openskyClientSecret: true,
      },
    );
    expect(payload).toEqual({
      aisRelaySharedSecret: "relay-secret",
      openskyClientSecret: "secret-1",
    });
  });
});
