import { describe, expect, it } from "vitest";

import {
  SYSTEM_HEALTH_DEFAULT_CONFIG,
  createQueueHealthSnapshot,
  evaluateSystemHealth,
  getPrimarySystemPressure,
  resolveSystemHealthAssessment,
} from "../app/(app)/components/system-health";

describe("system health scoring", () => {
  it("exports the configured metric weights", () => {
    expect(SYSTEM_HEALTH_DEFAULT_CONFIG.weights).toEqual({
      failed: 0.4,
      active: 0.3,
      delayed: 0.2,
      waiting: 0.1,
    });
  });

  it("returns a healthy 100 score when no queue pressure exists", () => {
    const snapshot = createQueueHealthSnapshot({
      active: 0,
      failed: 0,
      delayed: 0,
      waiting: 0,
    });

    expect(snapshot).not.toBeNull();
    expect(evaluateSystemHealth(snapshot!)).toMatchObject({
      state: "healthy",
      score: 100,
    });
  });

  it("downgrades sustained active load to warning without tripping critical", () => {
    const assessment = evaluateSystemHealth(
      createQueueHealthSnapshot({
        active: 80,
        failed: 0,
        delayed: 0,
        waiting: 0,
      })!,
    );

    expect(assessment.state).toBe("warning");
    expect(assessment.score).toBe(70);
  });

  it("degrades large waiting backlog without tripping critical", () => {
    const assessment = evaluateSystemHealth(
      createQueueHealthSnapshot({
        active: 0,
        failed: 0,
        delayed: 0,
        waiting: 120,
      })!,
    );

    expect(assessment.score).toBeLessThan(100);
    expect(assessment.state).not.toBe("critical");
  });

  it("marks failed spikes as critical", () => {
    const assessment = evaluateSystemHealth(
      createQueueHealthSnapshot({
        active: 6,
        failed: 8,
        delayed: 0,
        waiting: 12,
      })!,
    );

    expect(assessment.state).toBe("critical");
    expect(assessment.score).toBeLessThan(80);
  });

  it("marks delayed spikes as critical", () => {
    const assessment = evaluateSystemHealth(
      createQueueHealthSnapshot({
        active: 10,
        failed: 0,
        delayed: 25,
        waiting: 18,
      })!,
    );

    expect(assessment.state).toBe("critical");
  });

  it("identifies the dominant weighted pressure driver", () => {
    const assessment = evaluateSystemHealth(
      createQueueHealthSnapshot({
        active: 18,
        failed: 4,
        delayed: 2,
        waiting: 9,
      })!,
    );

    expect(getPrimarySystemPressure(assessment)).toMatchObject({
      metric: "failed",
    });
  });

  it("preserves non-data states for restricted and unavailable views", () => {
    expect(
      resolveSystemHealthAssessment({
        canManageQueue: false,
      }).state,
    ).toBe("unauthorized");

    expect(
      resolveSystemHealthAssessment({
        canManageQueue: true,
        loading: true,
      }).state,
    ).toBe("loading");

    const unavailable = resolveSystemHealthAssessment({
      canManageQueue: true,
      loading: false,
      error: new Error("network"),
    });
    expect(unavailable.state).toBe("unavailable");
    expect(unavailable.score).toBeNull();
  });
});
