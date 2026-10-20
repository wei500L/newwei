package economicdata

import (
	"context"
	"fmt"
	"log"
	"time"
)

// FetchAndPersist mirrors AkshareService.fetchAndPersist for one slug. The
// caller (the BullMQ worker) receives an error only for ordinary fetch failures;
// configuration errors finish the job successfully after recording skipped.
func (s *Service) FetchAndPersist(ctx context.Context, slug string) (int, error) {
	if s == nil || s.db == nil {
		return 0, fmt.Errorf("economicdata: mysql is not configured")
	}
	item, err := s.loadItemBySlug(ctx, slug)
	if err != nil {
		return 0, err
	}
	if item == nil {
		log.Printf("economicdata: failed to update fetch status for %s: item not found", slug)
		return 0, fmt.Errorf("Data item %s not found", slug)
	}
	definition, err := itemConfigFromRow(*item)
	if err != nil {
		return 0, s.recordOrdinaryFailure(ctx, *item, err)
	}
	provider, err := s.providerFor(definition.ProviderKind)
	if err != nil {
		return 0, s.recordOrdinaryFailure(ctx, *item, err)
	}
	result, fetchErr := provider.Fetch(ctx, definition)
	if fetchErr != nil {
		return 0, s.recordFetchError(ctx, definition, fetchErr)
	}
	if err := s.archiveProviderResponse(ctx, definition, result); err != nil {
		return 0, s.recordFetchError(ctx, definition, err)
	}
	deleted, err := s.applyProviderCleanup(ctx, definition.ItemID, result.Cleanup)
	if err != nil {
		return 0, s.recordFetchError(ctx, definition, err)
	}
	stored, err := s.bulkUpsertDataPoints(ctx, definition.ItemID, result.Points, &definition)
	if err != nil {
		return 0, s.recordFetchError(ctx, definition, err)
	}
	if err := s.updateFetchStatus(ctx, definition.ItemID, RunStatusSuccess, nil); err != nil {
		return 0, err
	}
	suffix := ""
	if deleted > 0 {
		suffix = fmt.Sprintf(" after deleting %d stale points", deleted)
	}
	log.Printf("economicdata: stored %d points for %s%s", stored, definition.Slug, suffix)
	return stored, nil
}

func (s *Service) recordFetchError(ctx context.Context, item ItemConfig, fetchErr error) error {
	if archiveErr := s.archiveProviderFailure(ctx, item, fetchErr); archiveErr != nil {
		log.Printf("economicdata: archive provider failure for %s: %v", item.Slug, archiveErr)
	}
	if configurationErr, ok := fetchErr.(*ProviderConfigurationError); ok {
		if err := s.markConfigUnavailable(ctx, item.ItemID, configurationErr.Message); err != nil {
			log.Printf("economicdata: mark skipped config %s: %v", item.Slug, err)
		}
		log.Printf("economicdata: skipped %s: %s", item.Slug, configurationErr.Message)
		return nil
	}
	if err := s.updateFetchStatus(ctx, item.ItemID, RunStatusFailed, fetchErr); err != nil {
		log.Printf("economicdata: record failure status for %s: %v", item.Slug, err)
	}
	return fetchErr
}

func (s *Service) recordOrdinaryFailure(ctx context.Context, item ItemRow, fetchErr error) error {
	definition, configErr := itemConfigFromRow(item)
	if configErr != nil {
		if err := s.updateFetchStatus(ctx, item.ID, RunStatusFailed, configErr); err != nil {
			log.Printf("economicdata: record failure status for %s: %v", item.Slug, err)
		}
		return configErr
	}
	return s.recordFetchError(ctx, definition, fetchErr)
}

func (s *Service) updateFetchStatus(ctx context.Context, itemID string, status RunStatus, fetchErr error) error {
	var message any
	if fetchErr != nil {
		message = truncateErrorMessage(fetchErr)
	}
	now := time.Now().UTC()
	result, err := s.db.ExecContext(ctx,
		"UPDATE `EconomicDataFetchConfig` SET `lastRunAt` = ?, `lastStatus` = ?, `lastError` = ?, `updatedAt` = ? WHERE `itemId` = ?",
		now, status, message, now, itemID)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 0 {
		// Nest's Prisma update would throw P2025; keep the fetch failure visible.
		return fmt.Errorf("EconomicDataFetchConfig not found for item %s", itemID)
	}
	return nil
}

func truncateErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	runes := []rune(message)
	if len(runes) <= 191 {
		return message
	}
	return string(runes[:188]) + "..."
}

// recordFetchFailure mirrors AkshareService.recordFetchFailure for callers that
// only have a slug: a missing item is logged, never created.
func (s *Service) recordFetchFailure(ctx context.Context, slug string, fetchErr error) {
	item, err := s.loadItemBySlug(ctx, slug)
	if err != nil || item == nil {
		log.Printf("economicdata: failed to update fetch status for %s: item not found", slug)
		return
	}
	if err := s.updateFetchStatus(ctx, item.ID, RunStatusFailed, fetchErr); err != nil {
		log.Printf("economicdata: failed to persist fetch failure for %s: %v", slug, err)
	}
}
