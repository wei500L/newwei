// Package crawlfrontiernode ports the Frontier node execution chain
// (CrawlFrontierService.processQueuedNode and everything it calls) from
// apps/api/src/modules/crawl/crawl-frontier.service.ts:
//
//   - processQueuedNode: the node state machine the crawl4ai-hot and
//     crawl4ai-normal queues run for `jobKind=frontier_node`;
//   - executeNode with its two branches: executeLayeredNode (one crawl4ai call,
//     result persistence, discovery expansion and the root seed branch) and
//     executeNativeRootNode (crawl4ai's native deep-crawl strategy at depth 0);
//   - the shared writes both branches need: persistFrontierResponse,
//     discoverChildNodes/discoverSeedNodes, the deferred LLM judge enqueue,
//     candidate materialization and the workflow run/step/event/candidate/trace
//     records.
//
// The package is a library: it never consumes a queue and never registers a
// worker. The crawl worker owns the three crawl queues and calls
//
//	ProcessQueuedNode(ctx, nodeID, orgID, requestTimeoutMs) (json.RawMessage, error)
//
// which returns the CrawlExecutionSummary JSON the NestJS worker resolved the
// BullMQ job with.
//
// Shared state is not re-implemented here. internal/crawlfrontierllm already
// ports the run/node/profile reads, the metadata merges, the workflow recorder,
// refreshRunStatus and the terminal lifecycle, the candidate materialization and
// the LLM judge/learn payloads; internal/crawlqueue owns the BullMQ job shapes;
// internal/crawlexecution owns the CrawlResult/CrawlResultContent writes;
// internal/crawlmetadata owns sitemap discovery. This package only adds the
// node-chain-specific orchestration on top of them.
//
// Two deliberate differences from the NestJS implementation are documented in
// place:
//
//   - B1 (export_lock.go in crawlfrontierllm): run/node metadata merges are
//     written under a SELECT ... FOR UPDATE row lock so two concurrently
//     finishing nodes of the same run cannot drop each other's metadata patch.
//     The merge semantics are unchanged; only the interleaving that NestJS loses
//     is removed.
//   - O3 (store.go): the node and its run are read in one JOIN statement
//     instead of Prisma's `include`, so every node execution saves one round
//     trip and both rows come from the same snapshot.
//
// O2 (merging the workflow event inserts) was verified and deliberately not
// applied: every appendEvent call computes its own sequence from the current
// event count and every candidate decision re-reads the candidate rows, so they
// are not independent inserts. See the PR description for the evidence.
//
// Error contract: the crawl4ai client error is returned untouched so
// errors.As(err, **crawl4ai.Error) still reads Status; every other error keeps
// the exact NestJS message text, because the worker classifies retryability from
// that text.
package crawlfrontiernode
