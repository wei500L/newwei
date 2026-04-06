import assert from "node:assert/strict";
import test from "node:test";

import { isLikelyMilitaryCandidate } from "../src/candidate-classification";

test("accepts military and government ship types", () => {
  assert.equal(isLikelyMilitaryCandidate({ ShipType: 35 }), true);
  assert.equal(isLikelyMilitaryCandidate({ ShipType: 55 }), true);
  assert.equal(isLikelyMilitaryCandidate({ ShipType: 59 }), true);
});

test("accepts recognized naval vessel name prefixes", () => {
  assert.equal(
    isLikelyMilitaryCandidate({
      MMSI: "123456789",
      ShipType: null,
      ShipName: "USS Example",
    }),
    true,
  );
});

test("rejects MMSI-only heuristics without supporting ship metadata", () => {
  assert.equal(
    isLikelyMilitaryCandidate({
      MMSI: "311990000",
      ShipType: null,
      ShipName: "Harbor Service 01",
    }),
    false,
  );
  assert.equal(
    isLikelyMilitaryCandidate({
      MMSI: "244001234",
      ShipType: null,
      ShipName: "Port Tender",
    }),
    false,
  );
});

test("rejects ordinary merchant vessels", () => {
  assert.equal(
    isLikelyMilitaryCandidate({
      MMSI: "123456789",
      ShipType: 72,
      ShipName: "Ever Forward",
    }),
    false,
  );
  assert.equal(
    isLikelyMilitaryCandidate({
      MMSI: "636020714",
      ShipType: null,
      ShipName: "KRITI EPISKOPI",
    }),
    false,
  );
  assert.equal(
    isLikelyMilitaryCandidate({
      MMSI: "503250800",
      ShipType: null,
      ShipName: "PLATINUM",
    }),
    false,
  );
});
