// Package knowledgereview migrates the manual knowledge-graph evidence review
// mutation (reviewKnowledgeGraphEvidence) into the Go GraphQL executor.
//
// The mutation is not a status update. One transaction normalizes the corrected
// relation, upserts the subject/object entities and their aliases, upserts the
// target edge, moves or merges the evidence row and recomputes the aggregate of
// every touched edge. Only after that transaction commits does the path write
// the audit row (with the existing AuditLogOutbox fallback), invalidate the two
// knowledge-graph cache prefixes and reload the response projection.
//
// Ingestion, the historical reconcile script and the audit outbox consumer stay
// in NestJS; this package only owns the reviewer-triggered write.
package knowledgereview
