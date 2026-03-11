import { describe, expect, it } from "vitest";

import { applyRealtimeSignalsSecretFields } from "../lib/realtime-signals-settings-payload";

describe("applyRealtimeSignalsSecretFields", () => {
  it("keeps untouched empty secret fields out of payload", () => {
    const payload: Record<string, unknown> = {};
    applyRealtimeSignalsSecretFields(
      payload,
      {
        relaySharedSecret: "",
        acledOauthPassword: "   ",
      },
      {
        relaySharedSecret: false,
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
        relaySharedSecret: "   ",
        acledOauthPassword: "",
      },
      {
        relaySharedSecret: true,
        acledOauthPassword: true,
      },
    );
    expect(payload).toEqual({
      relaySharedSecret: null,
      acledOauthPassword: null,
    });
  });

  it("sends trimmed non-empty secret values", () => {
    const payload: Record<string, unknown> = {};
    applyRealtimeSignalsSecretFields(
      payload,
      {
        relaySharedSecret: "  secret-1  ",
      },
      {
        relaySharedSecret: true,
      },
    );
    expect(payload).toEqual({
      relaySharedSecret: "secret-1",
    });
  });
});
