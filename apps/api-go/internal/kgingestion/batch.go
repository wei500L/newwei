package kgingestion

import (
	"context"
	"log"
	"time"
)

// maxArticleFailureAttempts is the K1 safety valve. The NestJS cron stops a
// batch at the first failed article and retries it on the next tick, but that
// alone lets one permanently failing article stall an organization forever.
// After this many consecutive failures the Go path skips the article and
// advances the cursor. This threshold is a new Go-side rule; it is documented
// in the pull request.
const maxArticleFailureAttempts = 3

// BatchStore is the MySQL surface the batch loop needs.
type BatchStore interface {
	ListProcessedArticles(ctx context.Context, orgID string, cursor *Cursor, limit int) ([]ProcessedArticle, error)
	AdvanceCursor(ctx context.Context, orgID string, processedAt time.Time, articleID string) error
}

// ArticleProcessor turns one ProcessedArticle into graph writes.
type ArticleProcessor interface {
	ProcessArticle(ctx context.Context, orgID string, article ProcessedArticle, settings Settings) (ArticleWriteStats, error)
}

// FailureCounter tracks consecutive failures of one organization/article pair.
// The production implementation is Redis with a one-day TTL.
type FailureCounter interface {
	Increment(ctx context.Context, orgID, articleID string) (int64, error)
	Reset(ctx context.Context, orgID, articleID string) error
}

// ArticleWriteStats is the per-article write result.
type ArticleWriteStats struct {
	EdgesUpserted      int
	ValidatedRelations int
	FilteredRelations  int
}

// BatchSummary is the per-organization result the scheduler logs.
type BatchSummary struct {
	ProcessedArticles  int
	FailedArticles     int
	UpsertedEdges      int
	ValidatedRelations int
	FilteredRelations  int
}

// runOrgBatch reproduces ingestOrg's article loop with K1 applied:
//
//   - A failed article breaks the batch without advancing the cursor, so the
//     next tick retries it instead of resuming past it. NestJS advances the
//     cursor for later successful articles, which permanently skips the failed
//     one.
//   - A failed cursor write is only logged; the article is already written and
//     K2 makes reprocessing idempotent.
//   - After maxArticleFailureAttempts consecutive failures the article is
//     skipped and the cursor advances, so one poisonous article cannot block an
//     organization forever.
func runOrgBatch(
	ctx context.Context,
	orgID string,
	settings Settings,
	cursor *Cursor,
	store BatchStore,
	failures FailureCounter,
	processor ArticleProcessor,
	logger *log.Logger,
) (BatchSummary, error) {
	summary := BatchSummary{}
	batch, err := store.ListProcessedArticles(ctx, orgID, cursor, settings.MaxBatchSize)
	if err != nil {
		if logger != nil {
			logger.Printf("kgingestion: failed to read processed articles orgId=%s err=%v", orgID, err)
		}
		return summary, err
	}
	if len(batch) == 0 {
		return summary, nil
	}

	for _, article := range batch {
		if err := ctx.Err(); err != nil {
			break
		}
		stats, processErr := processor.ProcessArticle(ctx, orgID, article, settings)
		if processErr != nil {
			summary.FailedArticles++
			if logger != nil {
				logger.Printf("kgingestion: skipped article due to processing error orgId=%s articleId=%s err=%v",
					orgID, article.ArticleID, processErr)
			}
			count, countErr := failures.Increment(ctx, orgID, article.ArticleID)
			if countErr != nil {
				if logger != nil {
					logger.Printf("kgingestion: failed to record article failure orgId=%s articleId=%s err=%v",
						orgID, article.ArticleID, countErr)
				}
				break
			}
			if count < maxArticleFailureAttempts {
				// Keep the cursor before this article: the next tick retries it.
				break
			}
			if logger != nil {
				logger.Printf("kgingestion: article failed %d consecutive times; skipping it orgId=%s articleId=%s",
					count, orgID, article.ArticleID)
			}
			_ = failures.Reset(ctx, orgID, article.ArticleID)
			if advanceErr := store.AdvanceCursor(ctx, orgID, article.ProcessedAt, article.ArticleID); advanceErr != nil && logger != nil {
				logger.Printf("kgingestion: failed to advance cursor past skipped article orgId=%s articleId=%s err=%v",
					orgID, article.ArticleID, advanceErr)
			}
			continue
		}

		summary.ProcessedArticles++
		summary.UpsertedEdges += stats.EdgesUpserted
		summary.ValidatedRelations += stats.ValidatedRelations
		summary.FilteredRelations += stats.FilteredRelations
		_ = failures.Reset(ctx, orgID, article.ArticleID)

		if advanceErr := store.AdvanceCursor(ctx, orgID, article.ProcessedAt, article.ArticleID); advanceErr != nil && logger != nil {
			logger.Printf("kgingestion: failed to advance cursor orgId=%s articleId=%s err=%v",
				orgID, article.ArticleID, advanceErr)
		}
	}
	return summary, nil
}
