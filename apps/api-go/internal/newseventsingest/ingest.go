package newseventsingest

import (
	"context"
	"log"
	"time"
)

// defaultSettleWindow is the NEWS_EVENTS_INGESTION_SETTLE_MS default.
const defaultSettleWindow = 120 * time.Second

// ingestRunner executes one organization run.
type ingestRunner struct {
	store    *store
	settings SettingsReader
	model    ModelServiceClient
	vectors  VectorSearcher
	settle   time.Duration
	now      func() time.Time
}

// clock returns the current time with millisecond precision.
func (r *ingestRunner) clock() time.Time {
	if r.now != nil {
		return r.now().UTC().Truncate(time.Millisecond)
	}
	return time.Now().UTC().Truncate(time.Millisecond)
}

// ingestOrg mirrors NewsEventsIngestionService.ingestOrg plus the B1 settle
// window and the O1 batch prefetch.
func (r *ingestRunner) ingestOrg(ctx context.Context, orgID string) error {
	settings, err := r.settings.ReadNewsEventSettings(ctx, orgID)
	if err != nil {
		return err
	}
	if !settings.Enabled || !settings.IngestionEnabled {
		return nil
	}

	now := r.clock()
	state, err := r.store.loadOrCreateIngestionState(ctx, orgID, now)
	if err != nil {
		return err
	}

	baselineStartAt := now.Add(-time.Duration(settings.BackfillDays) * 24 * time.Hour)
	if state.LastProcessedAt != nil {
		baselineStartAt = *state.LastProcessedAt
	}
	// B1: only articles whose processing transaction had time to commit are
	// read. processedAt is written by the pipeline's interactive transaction
	// when it upserts the ProcessedArticle; that transaction keeps writing the
	// outbox afterwards, so a row with an earlier processedAt can commit after a
	// row with a later one. Without this upper bound the cursor would step over
	// the late commit and that article would never be read again.
	cutoff := now.Add(-r.settle)
	query := buildIngestionBatchQuery(orgID, state, baselineStartAt, cutoff, settings.MaxBatchSize)
	batch, err := r.store.listProcessedArticles(ctx, query)
	if err != nil {
		return err
	}
	if len(batch) == 0 {
		return nil
	}

	leaves, leavesErr := r.store.loadProcessedItemLeaves(ctx, batchProcessedItemIDs(batch))
	if leavesErr != nil {
		// The NestJS modes differ here and the port keeps both semantics:
		//   - bertopic_primary loads the embeddings with an unguarded Mongo read,
		//     so a failure aborts the organization run and the cursor stays put;
		//   - the default mode resolves the embedding per article inside a
		//     try/catch, so a failure just means "no vector".
		if settings.ClusteringMode == ClusteringModeBertopicPrimary {
			return leavesErr
		}
		log.Printf("newseventsingest: processed item prefetch failed orgId=%s err=%v", orgID, leavesErr)
		leaves = map[string]processedItemLeaf{}
	}
	if leaves == nil {
		leaves = map[string]processedItemLeaf{}
	}

	assignments := &assigner{store: r.store, model: r.model, vectors: r.vectors, leaves: leaves, now: r.now}

	if settings.ClusteringMode == ClusteringModeBertopicPrimary {
		result, err := assignments.processBatch(ctx, orgID, batch, settings)
		if err != nil {
			return err
		}
		if err := r.updateStateToLastBatchEntry(ctx, orgID, batch); err != nil {
			return err
		}
		log.Printf("newseventsingest: org completed mode=bertopic_primary orgId=%s processed=%d assigned=%d queuedForManual=%d",
			orgID, result.ProcessedArticles, result.Assigned, result.QueuedForManual)
		return nil
	}

	processed := 0
	assigned := 0
	for _, entry := range batch {
		signal := r.buildSignal(entry, leaves, r.clock())
		result, err := assignments.AssignNewsSignalToEvent(ctx, orgID, signal, settings)
		if err != nil {
			return err
		}
		processed++
		if result.Created {
			assigned++
		}
		// The cursor advances after every article (A6): a failure in the middle
		// of the batch must not replay the articles already assigned.
		if err := r.store.updateIngestionState(ctx, orgID, *entry.ProcessedAt, entry.ArticleID, r.clock()); err != nil {
			return err
		}
	}
	log.Printf("newseventsingest: org completed mode=vector orgId=%s processed=%d assigned=%d",
		orgID, processed, assigned)
	return nil
}

// buildSignal builds one article's signal from the prefetched leaf.
func (r *ingestRunner) buildSignal(entry ProcessedArticleRecord, leaves map[string]processedItemLeaf, now time.Time) NewsSignal {
	processedItemID := jsNormalizeOptionalString(entry.CleanedMarkdownRef)
	var result []byte
	if processedItemID != nil {
		if leaf, found := leaves[*processedItemID]; found {
			result = leaf.Result
		}
	}
	return BuildNewsSignalFromProcessedArticle(BuildNewsSignalInput{
		ProcessedArticle:    entry,
		ProcessedItemResult: result,
		Now:                 now,
	})
}

// updateStateToLastBatchEntry mirrors updateStateToLastBatchEntry: the bertopic
// mode moves the cursor once, after the whole batch succeeded.
func (r *ingestRunner) updateStateToLastBatchEntry(ctx context.Context, orgID string, batch []ProcessedArticleRecord) error {
	if len(batch) == 0 {
		return nil
	}
	last := batch[len(batch)-1]
	return r.store.updateIngestionState(ctx, orgID, *last.ProcessedAt, last.ArticleID, r.clock())
}
