package crawlfrontierllm

// export_lock.go is the B1 fix: row-locked metadata merge writes.
//
// B1 (verified against main 170a95d8):
//
//   - NestJS updateRunMetadata (crawl-frontier.service.ts:5088) and
//     updateNodeMetadata (5128) both SELECT the metadata document, merge in
//     memory, then UPDATE the whole column, with no lock in between. The Go port
//     (store.go:329/351) copied that read-modify-write.
//   - One CrawlFrontierRun is fanned out over many nodes, and the crawl worker
//     processes them concurrently (hot and normal queues run side by side, the
//     worker concurrency reaches 20). refreshRunStatus runs updateRunMetadata on
//     every node completion, and the frontier_node_started/failed paths also
//     write run metadata. Two nodes finishing together therefore read the same
//     old document and the later write drops the earlier patch: coverage
//     counters, warningFlags, rootDiagnosis and the queue/LLM bookkeeping are
//     all silently lost.
//
// The fix keeps the exact NestJS merge semantics but does the read inside the
// same transaction as the write and takes a row lock:
//
//	BEGIN
//	SELECT metadata FROM ... WHERE id = ? FOR UPDATE
//	UPDATE ... SET metadata = <merged>, updatedAt = ? WHERE id = ?
//	COMMIT
//
// This is a deliberate Go-only behaviour change: the merge result is what NestJS
// produces whenever the writes are serialized, and the row lock only removes the
// interleaving that NestJS loses. The judge/learn entry points can switch to
// these helpers without any other change.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// UpdateRunMetadataLocked merges patch into CrawlFrontierRun.metadata under a
// row lock, so concurrent completions in the same run cannot drop each other's
// keys.
func (s *Service) UpdateRunMetadataLocked(ctx context.Context, runID string, patch *Object) error {
	if s.db == nil {
		return errNoDB()
	}
	if patch == nil {
		return nil
	}
	return s.withLockedMetadata(ctx,
		"SELECT metadata FROM CrawlFrontierRun WHERE id = ? FOR UPDATE",
		"UPDATE CrawlFrontierRun SET metadata = ?, updatedAt = ? WHERE id = ?",
		runID,
		func(*Object) *Object { return patch },
	)
}

// UpdateNodeMetadataLocked is the node counterpart of UpdateRunMetadataLocked.
func (s *Service) UpdateNodeMetadataLocked(ctx context.Context, nodeID string, patch *Object) error {
	return s.UpdateNodeMetadataFuncLocked(ctx, nodeID, func(*Object) *Object { return patch })
}

// UpdateNodeMetadataFuncLocked is the functional (existing-metadata aware) form.
// The builder runs against the freshly locked document, exactly like the NestJS
// `patch(existing)` callback, so derived fields such as a decremented
// pendingLlmJudgeJobs counter stay correct under concurrency.
func (s *Service) UpdateNodeMetadataFuncLocked(ctx context.Context, nodeID string, build func(existing *Object) *Object) error {
	if s.db == nil {
		return errNoDB()
	}
	return s.withLockedMetadata(ctx,
		"SELECT metadata FROM CrawlFrontierNode WHERE id = ? FOR UPDATE",
		"UPDATE CrawlFrontierNode SET metadata = ?, updatedAt = ? WHERE id = ?",
		nodeID,
		build,
	)
}

// withLockedMetadata runs the SELECT ... FOR UPDATE, the merge and the UPDATE in
// one transaction. A missing row keeps the NestJS no-op behaviour (Prisma would
// throw P2025, but every call site passes an id read in the same request, and
// the existing unlocked helpers already return nil for a missing row).
func (s *Service) withLockedMetadata(ctx context.Context, selectSQL, updateSQL, id string, build func(existing *Object) *Object) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("crawlfrontierllm: begin metadata transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var raw []byte
	scanErr := tx.QueryRowContext(ctx, selectSQL, id).Scan(&raw)
	if scanErr != nil && !errors.Is(scanErr, sql.ErrNoRows) {
		return scanErr
	}
	existing := parseObjectOrNil(raw)
	patch := build(existing)
	merged := mergeObjects(existing, patch)
	if merged == nil {
		merged = NewObject()
	}
	encoded, err := merged.MarshalJSON()
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, updateSQL, encoded, truncateMillis(s.now()), id); err != nil {
		return err
	}
	return tx.Commit()
}

// errNoDB is the shared missing-handle error.
func errNoDB() error { return errNotConfiguredLLM("crawlfrontierllm: mysql is not configured") }

type errNotConfiguredLLM string

func (e errNotConfiguredLLM) Error() string { return string(e) }
