import {
  computeBestLagCorrelation,
  runBacktest,
  type BacktestConfig,
  type DailySeries
} from "../news-indicator-math";

describe("news-indicator-math", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("selects best lag by correlation", () => {
    const base = Date.UTC(2026, 0, 1);

    const feature: DailySeries = new Map([
      [base + 0 * DAY_MS, 3],
      [base + 1 * DAY_MS, 0],
      [base + 2 * DAY_MS, 5],
      [base + 3 * DAY_MS, 1],
      [base + 4 * DAY_MS, 4]
    ]);

    const targetReturns: DailySeries = new Map([
      [base + 1 * DAY_MS, 0.3],
      [base + 2 * DAY_MS, 0],
      [base + 3 * DAY_MS, 0.5],
      [base + 4 * DAY_MS, 0.1],
      [base + 5 * DAY_MS, 0.4]
    ]);

    const { best } = computeBestLagCorrelation(feature, targetReturns, { maxLagDays: 2, minSampleSize: 3 });

    expect(best).not.toBeNull();
    expect(best!.lagDays).toBe(1);
    expect(best!.correlation).toBeGreaterThan(0.8);
  });

  it("backtests using rolling baseline without look-ahead", () => {
    const base = Date.UTC(2026, 0, 1);

    const feature: DailySeries = new Map([
      [base + 0 * DAY_MS, 1],
      [base + 1 * DAY_MS, 1],
      [base + 2 * DAY_MS, 1],
      [base + 3 * DAY_MS, 2],
      [base + 4 * DAY_MS, 1],
      [base + 5 * DAY_MS, 10],
      [base + 6 * DAY_MS, 1]
    ]);

    const targetReturns: DailySeries = new Map([
      [base + 6 * DAY_MS, 0.05]
    ]);

    const config: BacktestConfig = {
      triggerZScore: 2,
      baselineDays: 5,
      holdoutDays: 0,
      evaluationTargetStartDayMs: base + 6 * DAY_MS,
      evaluationTargetEndDayMs: base + 7 * DAY_MS
    };

    const metrics = runBacktest(feature, targetReturns, { lagDays: 1, correlation: 0.9 }, config);

    expect(metrics.triggers).toBe(1);
    expect(metrics.evaluatedSignals).toBe(1);
    expect(metrics.hits).toBe(1);
    expect(metrics.hitRate).toBeCloseTo(1);
  });
});

