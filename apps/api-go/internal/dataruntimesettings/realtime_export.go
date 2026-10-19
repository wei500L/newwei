package dataruntimesettings

import "context"

// This file is the minimal export surface the runtime diagnostics unit needs from
// the data runtime settings domain. It exposes the already normalized effective
// realtime configuration and its source; it adds no new normalization and never
// writes a cache or refreshes an ACLED token.

// RealtimeRuntimeSettings is the normalized realtime configuration. It contains
// only the members the diagnostics response needs.
type RealtimeRuntimeSettings struct {
	Enabled                     bool
	RequestTimeoutMs            int
	MaxRetries                  int
	OpenskyEnabled              bool
	OpenskyIntervalSec          int
	OpenskyDailyCreditBudget    int
	OpenskyDayIntervalSec       int
	OpenskyNightIntervalSec     int
	OpenskyDayStartHourHKT      int
	OpenskyNightStartHourHKT    int
	OpenskyWarningRemainingPct  int
	OpenskyCriticalRemainingPct int
	AisEnabled                  bool
	AisIntervalSec              int
	UnrestEnabled               bool
	UnrestIntervalSec           int
	OutagesEnabled              bool
	OutagesIntervalSec          int
	KeywordSpikeEnabled         bool
	KeywordSpikeIntervalSec     int
	PizzintEnabled              bool
	PizzintIntervalSec          int
	GdeltTensionEnabled         bool
	GdeltTensionIntervalSec     int
	PolymarketLeadsEnabled      bool
	PolymarketLeadsIntervalSec  int
}

func exportRealtimeRuntime(effective *effectiveRealtimeSettings) *RealtimeRuntimeSettings {
	if effective == nil {
		return nil
	}
	return &RealtimeRuntimeSettings{
		Enabled:                     effective.Enabled,
		RequestTimeoutMs:            effective.RequestTimeoutMs,
		MaxRetries:                  effective.MaxRetries,
		OpenskyEnabled:              effective.OpenskyEnabled,
		OpenskyIntervalSec:          effective.OpenskyIntervalSec,
		OpenskyDailyCreditBudget:    effective.OpenskyDailyCreditBudget,
		OpenskyDayIntervalSec:       effective.OpenskyDayIntervalSec,
		OpenskyNightIntervalSec:     effective.OpenskyNightIntervalSec,
		OpenskyDayStartHourHKT:      effective.OpenskyDayStartHourHKT,
		OpenskyNightStartHourHKT:    effective.OpenskyNightStartHourHKT,
		OpenskyWarningRemainingPct:  effective.OpenskyWarningRemainingPct,
		OpenskyCriticalRemainingPct: effective.OpenskyCriticalRemainingPct,
		AisEnabled:                  effective.AisEnabled,
		AisIntervalSec:              effective.AisIntervalSec,
		UnrestEnabled:               effective.UnrestEnabled,
		UnrestIntervalSec:           effective.UnrestIntervalSec,
		OutagesEnabled:              effective.OutagesEnabled,
		OutagesIntervalSec:          effective.OutagesIntervalSec,
		KeywordSpikeEnabled:         effective.KeywordSpikeEnabled,
		KeywordSpikeIntervalSec:     effective.KeywordSpikeIntervalSec,
		PizzintEnabled:              effective.PizzintEnabled,
		PizzintIntervalSec:          effective.PizzintIntervalSec,
		GdeltTensionEnabled:         effective.GdeltTensionEnabled,
		GdeltTensionIntervalSec:     effective.GdeltTensionIntervalSec,
		PolymarketLeadsEnabled:      effective.PolymarketLeadsEnabled,
		PolymarketLeadsIntervalSec:  effective.PolymarketLeadsIntervalSec,
	}
}

// EffectiveRealtimeRuntime loads the settings (Redis cache, then MySQL) and
// resolves the effective configuration without refreshing any token.
func (s *Service) EffectiveRealtimeRuntime(ctx context.Context) (*RealtimeRuntimeSettings, error) {
	stored, err := s.loadRealtimeSettings(ctx)
	if err != nil {
		return nil, err
	}
	effective, err := s.resolveEffectiveSettings(stored)
	if err != nil {
		return nil, err
	}
	return exportRealtimeRuntime(effective), nil
}

// EnvRealtimeRuntime resolves the environment-only fallback, used when the
// stored settings cannot be read (the NestJS fromEnvConfig branch).
func (s *Service) EnvRealtimeRuntime() *RealtimeRuntimeSettings {
	effective, err := s.resolveEffectiveSettings(nil)
	if err != nil {
		return nil
	}
	return exportRealtimeRuntime(effective)
}

// RealtimeSettingsSource reports "db" when a settings row exists, "env"
// otherwise.
func (s *Service) RealtimeSettingsSource(ctx context.Context) (string, error) {
	stored, err := s.loadRealtimeSettings(ctx)
	if err != nil {
		return "", err
	}
	if stored != nil {
		return "db", nil
	}
	return "env", nil
}
