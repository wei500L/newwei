import assert from "node:assert/strict";
import test from "node:test";

import { closeUpstreamSocketForShutdown } from "../src/shutdown";

test("closes an open upstream websocket during shutdown", () => {
  let removeAllListenersCalls = 0;
  let closeCalls = 0;

  closeUpstreamSocketForShutdown({
    readyState: 1,
    removeAllListeners() {
      removeAllListenersCalls += 1;
    },
    close() {
      closeCalls += 1;
    },
  });

  assert.equal(removeAllListenersCalls, 1);
  assert.equal(closeCalls, 1);
});

test("skips close when the upstream websocket is still connecting", () => {
  let removeAllListenersCalls = 0;
  let closeCalls = 0;

  closeUpstreamSocketForShutdown({
    readyState: 0,
    removeAllListeners() {
      removeAllListenersCalls += 1;
    },
    close() {
      closeCalls += 1;
      throw new Error("close should not be called while connecting");
    },
  });

  assert.equal(removeAllListenersCalls, 1);
  assert.equal(closeCalls, 0);
});
