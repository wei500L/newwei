jest.mock("@modular/mongo", () => ({
  SituationSignalFeedbackModel: { create: jest.fn() },
  SituationSignalLearningStateModel: {
    updateOne: jest.fn(() => ({ exec: jest.fn(async () => ({ ok: 1 })) })),
  },
}));

import { SituationMonitorFeedbackService } from "../situation-monitor-feedback.service";

describe("SituationMonitorFeedbackService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("upserts learning state without conflicting update paths (false_positive)", async () => {
    const cacheMock = { incr: jest.fn(async () => 1) } as any;
    const service = new SituationMonitorFeedbackService(cacheMock);

    const mongo = jest.requireMock("@modular/mongo") as any;

    await service.recordFeedback({
      orgId: "org",
      userId: "user",
      signalType: "correlation",
      signalId: "election",
      label: "false_positive",
      itemMetaId: "meta-1",
      itemLink: "https://example.com/article",
      itemTitle: "Family ties feature in Nepal parliamentary elections race",
      itemSource: "kathmandupost.com",
    });

    expect(mongo.SituationSignalFeedbackModel.create).toHaveBeenCalledTimes(1);
    expect(mongo.SituationSignalLearningStateModel.updateOne).toHaveBeenCalledTimes(1);

    const [, update] = mongo.SituationSignalLearningStateModel.updateOne.mock.calls[0];
    expect(update).toMatchObject({
      $setOnInsert: { orgId: "org", signalType: "correlation", signalId: "election" },
      $inc: { falsePositiveCount: 1 },
      $addToSet: { suppressedItemMetaIds: "meta-1" },
    });

    // Avoid $setOnInsert + $inc/$addToSet conflicts on initial upsert.
    expect(update.$setOnInsert.falsePositiveCount).toBeUndefined();
    expect(update.$setOnInsert.falseNegativeCount).toBeUndefined();
    expect(update.$setOnInsert.suppressedItemMetaIds).toBeUndefined();
    expect(update.$setOnInsert.boostedTokenCounts).toBeUndefined();
    expect(update.$setOnInsert.blockedTokenCounts).toBeUndefined();

    expect(Object.keys(update.$inc).some((key) => key.startsWith("blockedTokenCounts."))).toBe(true);

    expect(cacheMock.incr).toHaveBeenCalledWith(
      "situation-monitor:insights:learning-rev:v1:org",
      60 * 60 * 24 * 90,
    );
  });

  it("upserts learning state without conflicting update paths (false_negative)", async () => {
    const cacheMock = { incr: jest.fn(async () => 1) } as any;
    const service = new SituationMonitorFeedbackService(cacheMock);

    const mongo = jest.requireMock("@modular/mongo") as any;

    await service.recordFeedback({
      orgId: "org",
      userId: "user",
      signalType: "narrative",
      signalId: "immigration",
      label: "false_negative",
      itemLink: "https://example.com/article",
      itemTitle: "Immigration rhetoric gains traction",
      itemSource: "example.com",
    });

    expect(mongo.SituationSignalFeedbackModel.create).toHaveBeenCalledTimes(1);
    expect(mongo.SituationSignalLearningStateModel.updateOne).toHaveBeenCalledTimes(1);

    const [, update] = mongo.SituationSignalLearningStateModel.updateOne.mock.calls[0];
    expect(update).toMatchObject({
      $setOnInsert: { orgId: "org", signalType: "narrative", signalId: "immigration" },
      $inc: { falseNegativeCount: 1 },
    });

    expect(update.$setOnInsert.falsePositiveCount).toBeUndefined();
    expect(update.$setOnInsert.falseNegativeCount).toBeUndefined();
    expect(update.$setOnInsert.boostedTokenCounts).toBeUndefined();
    expect(update.$setOnInsert.blockedTokenCounts).toBeUndefined();

    expect(Object.keys(update.$inc).some((key) => key.startsWith("boostedTokenCounts."))).toBe(true);
  });
});
