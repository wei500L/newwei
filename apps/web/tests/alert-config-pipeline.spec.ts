import { describe, expect, it } from "vitest";

import { AlertMetricProvider } from "../graphql/generated";
import {
  buildPipelineProviderMetadata,
  DEFAULT_PIPELINE_OUTBOX_TYPE,
  isMongoOutboxMetricSlug,
  resolveInitialPipelineOutboxType,
  stripControlledMetadataForProvider,
} from "../app/(app)/dashboard/alert-config.pipeline";

describe("alert config pipeline helpers", () => {
  it("treats mongo_outbox slugs as outbox metrics", () => {
    expect(isMongoOutboxMetricSlug("mongo_outbox.dead")).toBe(true);
    expect(isMongoOutboxMetricSlug("pipeline_job")).toBe(false);
  });

  it("defaults outbox rules to processed_item when metadata.type is missing", () => {
    expect(
      resolveInitialPipelineOutboxType("mongo_outbox.dead", undefined),
    ).toBe(DEFAULT_PIPELINE_OUTBOX_TYPE);
    expect(resolveInitialPipelineOutboxType("pipeline_job", undefined)).toBe(
      undefined,
    );
  });

  it("builds pipeline job metadata from status, queue, and source filters", () => {
    expect(
      buildPipelineProviderMetadata({
        metricSlug: "pipeline_job",
        pipelineStatuses: ["failed"],
        pipelineQueueName: " ingest ",
        pipelineSourceId: " source-1 ",
      }),
    ).toEqual({
      statuses: ["failed"],
      queueName: "ingest",
      sourceId: "source-1",
    });
  });

  it("builds outbox metadata from the dedicated outbox type selector", () => {
    expect(
      buildPipelineProviderMetadata({
        metricSlug: "mongo_outbox.dead",
        pipelineStatuses: ["failed"],
        pipelineQueueName: "ignored",
        pipelineSourceId: "ignored",
        pipelineOutboxType: "cleanup_crawl_results",
      }),
    ).toEqual({
      type: "cleanup_crawl_results",
    });
  });

  it("strips controlled metadata keys before provider-specific values are merged", () => {
    expect(
      stripControlledMetadataForProvider({
        metricProvider: AlertMetricProvider.PipelineJob,
        metadata: {
          statuses: ["failed"],
          status: "failed",
          queueName: "queue-a",
          sourceId: "source-1",
          type: "processed_item",
          muteUntil: "2026-03-24T00:00:00.000Z",
          custom: true,
        },
      }),
    ).toEqual({
      muteUntil: "2026-03-24T00:00:00.000Z",
      custom: true,
    });
  });
});
