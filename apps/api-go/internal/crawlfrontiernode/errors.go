package crawlfrontiernode

// errors.go pins the error contract the crawl worker relies on.
//
// Two rules, both from the interface contract:
//
//  1. The Error() text of every non-crawl4ai failure must equal the NestJS
//     message byte for byte, because the worker classifies retryable failures by
//     searching the text for the hints NestJS produced ("timeout",
//     "temporarily", "rate limit", "connection reset", "connection refused") and
//     for the memory-pressure hints. Nothing here may wrap, prefix or rewrite
//     the text.
//  2. A crawl4ai request failure must stay a *crawl4ai.Error inside the returned
//     error, so the worker can read Status with errors.As and decide whether the
//     status is retryable. executeNode therefore returns the client error
//     untouched; wrapping it would hide the status from errors.As.
//
// NestJS throws NotFoundException/BadRequestException, whose status is never
// inspected by the worker; the status is kept so an HTTP caller of a future
// adapter sees the same class.

import (
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// NestJS messages, verbatim.
const (
	messageNodeNotFound         = "Crawl frontier node not found"
	messageProfileUnresolved    = "Crawl frontier run cannot resolve site profile"
	messageMissingCrawlTaskID   = "Crawl frontier run is missing crawlTaskId"
	messageSyntheticTaskMissing = "Synthetic crawl task not found for crawl frontier run"
)

// newNodeNotFoundError is `throw new NotFoundException("Crawl frontier node
// not found")`. It is also the cross-tenant answer: the worker must not learn
// whether a node id exists in another organization.
func newNodeNotFoundError() error {
	return &crawlfrontierllm.NestError{Status: 404, Message: messageNodeNotFound}
}

// newBadRequestError is `throw new BadRequestException(message)`.
func newBadRequestError(message string) error {
	return &crawlfrontierllm.NestError{Status: 400, Message: message}
}

// classifyFailureKind is classifyFrontierFailureKind(message) for a non-nil
// message. NestJS receives `error instanceof Error ? error.message : "crawl
// frontier node failed"`, so the caller already replaced a non-Error with that
// literal before classifying.
func classifyFailureKind(message string) *string {
	return crawlfrontierllm.ClassifyFrontierFailureKind(&message)
}
