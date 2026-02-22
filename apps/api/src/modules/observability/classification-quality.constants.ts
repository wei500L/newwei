export const CLASSIFICATION_QUALITY_QUEUE_NAME = "classification_quality";
export const CLASSIFICATION_QUALITY_QUEUE = Symbol(
  "CLASSIFICATION_QUALITY_QUEUE",
);

interface ClassificationQualityJobPayloadBase {
  jobType: "report" | "review_seed_item";
  orgId: string;
  traceId: string;
}

export interface ClassificationQualityReportJobPayload
  extends ClassificationQualityJobPayloadBase {
  jobType: "report";
  reportJobId: string;
}

export interface ClassificationQualityReviewSeedItemJobPayload
  extends ClassificationQualityJobPayloadBase {
  jobType: "review_seed_item";
  processedItemId: string;
}

export type ClassificationQualityJobPayload =
  | ClassificationQualityReportJobPayload
  | ClassificationQualityReviewSeedItemJobPayload;
