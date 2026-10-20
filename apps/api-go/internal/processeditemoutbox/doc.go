// Package processeditemoutbox owns the Go execution of the processed_item
// MongoOutbox compensation chain.
//
// It is a background-only unit behind API_GO_PROCESSED_ITEM_OUTBOX_MODE=go. The
// five-minute wall-clock tick takes lock:cron:processed-item-outbox, scans due
// ids without loading the embedding payload, claims each row with the same
// conditional update as NewsPipelineOutboxService.claimOutboxEntry, then reads
// the payload and executes the legacy delivery order:
//
//	ItemMeta + RawItem -> ProcessedItem upsert -> vector-go upsert ->
//	ItemMeta completion/name/publishedAt -> itemreadmodels upsert -> outbox delete
//
// The CAS claim is shared with NestJS immediate delivery and its in-process
// retry, so two owners can never deliver the same row concurrently. Failures
// use the unchanged 30-second exponential backoff (ten attempts), and the tenth
// failure parks the row as dead and compensates the ProcessedItem and read
// model to failed. Invalid payloads are parked as dead without compensation.
//
// B1 intentionally improves on the legacy per-tick one-batch limit: the tick
// drains batches of ten with bounded concurrency until no due ids remain or the
// configured tick budget is exhausted. O1 keeps the scan id-only, which avoids
// transferring summary embeddings for rows another executor owns.
package processeditemoutbox
