# Concurrency Controls

This document maps user-facing concurrency knobs to the execution paths they actually control, and lists notable fixed or environment-only limits nearby.

## User-Facing Controls

| Surface                                                        | Scope                          | Controls                                                                             | Does not control                                                                                                     |
| -------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `Create Crawl Task -> Concurrency`                             | Per crawl task                 | Crawl request fan-out stored on the task payload                                     | Crawl queue worker budget; crawl-result to `Items` ingest fan-out                                                    |
| `Admin -> Crawl Ops -> Global max concurrency`                 | Shared crawl queue runtime     | Hot/normal crawl queue worker budget and BullMQ global concurrency                   | Per-task crawl request fan-out; detail publish-signal head fetch concurrency; crawl-result to `Items` ingest fan-out |
| `Crawl client -> Detail publish-signal head fetch concurrency` | Publish-time enrichment only   | Parallel head fetches used when enriching publish-time signals                       | Crawl queue worker budget; per-task crawl concurrency; `Items` ingest fan-out                                        |
| `Situation Monitor -> Translation max concurrency`             | Translation runtime            | Situation Monitor translation requests; RSS LLM translation concurrency              | Crawl queue worker budget; LiteLLM managed runtime governance                                                        |
| `News dedupe -> Judge concurrency`                             | Per dedupe decision            | Parallel LLM dedupe comparisons for one item                                         | Item pipeline worker concurrency; LiteLLM managed runtime governance                                                 |
| `Archive preparation -> Embedding/Rerank max concurrency`      | Archive background preparation | Embedding and rerank fan-out inside archive preparation                              | Archive queue worker concurrency outside that runtime; crawl/item pipeline workers                                   |
| `LLM gateway -> Max parallel requests`                         | LiteLLM governance             | Max in-flight requests on the managed LiteLLM runtime key when governance is enabled | App-side worker concurrency; proxy load-balancing test concurrency                                                   |

## Fixed Or Env-Only Limits

- `apps/api/src/modules/items/items.service.ts`
  `CRAWL_RESULT_INGEST_CONCURRENCY = 8`
  Controls crawl-result to `Items` ingest fan-out. Not user-configurable today.
- `apps/api/src/modules/crawl/crawl-result.service.ts`
  `RESULT_PERSIST_CONCURRENCY_LIMIT = 6`
  Controls crawl result persistence batching. Not user-configurable today.
- `apps/api/src/modules/crawl/crawl-media-asset.service.ts`
  `CRAWL_MEDIA_ASSET_SIGN_CONCURRENCY = 8`
  Controls media asset signing fan-out. Not user-configurable today.
- `apps/api/src/modules/audit/audit-log-outbox.service.ts`
  `AUDIT_LOG_OUTBOX_DELIVERY_CONCURRENCY = 8`
  Controls audit outbox delivery fan-out. Not user-configurable today.
- `apps/api/src/modules/queue/queue.processor.ts`
  `newsPipelineEnv.processQueueConcurrency`
  Environment-only item pipeline worker concurrency.
- `apps/api/src/modules/observability/classification-quality.processor.ts`
  `newsPipelineEnv.processQueueConcurrency`
  Environment-only classification-quality worker concurrency, clamped to `1..4`.

## Crawl-Specific Notes

- Task-level crawl concurrency is capped by the service crawl concurrency ceiling in `apps/api/src/modules/crawl/crawl-task.service.ts`.
- Crawl queue global concurrency is loaded from runtime settings in `apps/api/src/modules/crawl/crawl.processor.ts` and applied to queue global concurrency plus in-process workers.
- Crawl-result to `Items` ingest currently uses a separate fixed internal concurrency of `8`, so changing crawl queue global concurrency does not change that path.

## Maintenance Rule

When changing any concurrency-related setting or constant, update this document and the nearest user-facing hint in `apps/web` if the scope could be misread.
