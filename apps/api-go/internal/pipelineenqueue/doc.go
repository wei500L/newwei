// Package pipelineenqueue is the narrow BullMQ producer for the existing
// itemPipeline queue.
//
// It implements exactly the two official BullMQ v5.63.2 add scripts this chain
// needs (standard and prioritized jobs), the packed MessagePack arguments and
// options they expect, the stable processed-item id lookup, the best-effort
// pending ProcessedItem upsert and the QueueOrgStatsService counter Lua.
//
// The package deliberately contains no consumer, worker, repeat/flow support,
// QueueEvents publisher or schema regression. NestJS keeps executing
// process-item jobs and publishing queue events; this producer only writes the
// same Redis protocol NestJS writes.
package pipelineenqueue
