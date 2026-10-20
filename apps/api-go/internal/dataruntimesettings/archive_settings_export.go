package dataruntimesettings

// This file is the read-only export surface the archive-preparation worker
// needs. It adds no behaviour: the values come from the same cached stored
// document and the same clamp rules as the settings HTTP routes.

import (
	"context"
	"encoding/json"
)

// ArchivePreparationEffectiveSettings is the four-field runtime contract the
// preparation worker resolves at the start of every job.
type ArchivePreparationEffectiveSettings struct {
	JobBatchSize            int
	EmbeddingBatchSize      int
	EmbeddingMaxConcurrency int
	RerankMaxConcurrency    int
}

// EffectiveArchivePreparationSettings reproduces ArchivePreparationSettingsService
// getEffectiveSettings: read the cached raw stored value (or the JSON null for a
// missing row) and normalize the four members with the same defaults and clamps.
func (s *Service) EffectiveArchivePreparationSettings(ctx context.Context) (ArchivePreparationEffectiveSettings, error) {
	raw, err := s.loadArchivePreparationStored(ctx)
	if err != nil {
		return ArchivePreparationEffectiveSettings{}, err
	}
	settings := normalizeArchivePreparation(parseStoredArchivePreparationSettings(raw))
	return ArchivePreparationEffectiveSettings{
		JobBatchSize:            settings.JobBatchSize,
		EmbeddingBatchSize:      settings.EmbeddingBatchSize,
		EmbeddingMaxConcurrency: settings.EmbeddingMaxConcurrency,
		RerankMaxConcurrency:    settings.RerankMaxConcurrency,
	}, nil
}

// ArchivePreparationStoredValue exposes the raw settings document for tests and
// diagnostics without interpreting it.
func (s *Service) ArchivePreparationStoredValue(ctx context.Context) (json.RawMessage, error) {
	return s.loadArchivePreparationStored(ctx)
}
