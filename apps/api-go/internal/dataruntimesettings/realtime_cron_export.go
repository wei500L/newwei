package dataruntimesettings

import "context"

// This file is the export surface the realtime-signals collector needs from the
// data runtime settings domain. It exposes the same effective configuration
// RealtimeSignalsSettingsService.getRuntimeConfig returns, including the
// credentials, endpoint overrides and thresholds the eight collectors use, plus
// the ACLED OAuth state machine that runs on demand from the collection path.
//
// Nothing here re-normalizes a setting: every value comes from
// resolveEffectiveSettings, so the HTTP settings unit and the collector cannot
// disagree about a stored or environment value.

// RealtimeCronCapabilities mirrors RealtimeSignalsRuntimeConfig.capabilities.
type RealtimeCronCapabilities struct {
	// AcledAPIEnabled stays false: the NestJS service hard-codes
	// ACLED_API_ENABLED = false because Open myACLED has no API access.
	AcledAPIEnabled        bool
	AcledAPIDisabledReason string
}

// RealtimeCronSource is one entry of RealtimeSignalsRuntimeConfig.sources.
type RealtimeCronSource struct {
	Enabled     bool
	IntervalSec int
}

// RealtimeCronSources is the fixed source set in the NestJS member order.
type RealtimeCronSources struct {
	Opensky         RealtimeCronSource
	Ais             RealtimeCronSource
	Unrest          RealtimeCronSource
	Outages         RealtimeCronSource
	KeywordSpike    RealtimeCronSource
	Pizzint         RealtimeCronSource
	GdeltTension    RealtimeCronSource
	PolymarketLeads RealtimeCronSource
}

// RealtimeCronThresholds mirrors RealtimeSignalsRuntimeConfig.thresholds.
type RealtimeCronThresholds struct {
	KeywordSpikeMinCount            int
	KeywordSpikeMultiplier          float64
	PredictionShiftThreshold        float64
	PredictionNewsActivityThreshold int
}

// RealtimeCronAisRelay mirrors RealtimeSignalsRuntimeConfig.aisRelay.
type RealtimeCronAisRelay struct {
	BaseURL      string
	SharedSecret string
}

// RealtimeCronOpensky mirrors RealtimeSignalsRuntimeConfig.opensky.
type RealtimeCronOpensky struct {
	BaseURL              string
	TokenURL             string
	ClientID             string
	ClientSecret         string
	DailyCreditBudget    int
	DayIntervalSec       int
	NightIntervalSec     int
	DayStartHourHKT      int
	NightStartHourHKT    int
	WarningRemainingPct  int
	CriticalRemainingPct int
}

// RealtimeCronCredentials mirrors RealtimeSignalsRuntimeConfig.credentials.
type RealtimeCronCredentials struct {
	AcledAccessToken   string
	CloudflareAPIToken string
	WingbitsAPIKey     string
}

// RealtimeCronPolymarket mirrors RealtimeSignalsRuntimeConfig.polymarket.
type RealtimeCronPolymarket struct {
	ProxyURL string
}

// RealtimeCronRuntime is the resolved configuration of one collection round.
// Empty strings are the Go representation of the NestJS `undefined` optional
// members.
type RealtimeCronRuntime struct {
	Enabled          bool
	RequestTimeoutMs int
	MaxRetries       int
	Capabilities     RealtimeCronCapabilities
	Sources          RealtimeCronSources
	Thresholds       RealtimeCronThresholds
	AisRelay         RealtimeCronAisRelay
	Opensky          RealtimeCronOpensky
	Credentials      RealtimeCronCredentials
	Polymarket       RealtimeCronPolymarket
}

// acledAPIEnabled / acledAPIDisabledReason are the hard-coded ACLED policy of
// RealtimeSignalsSettingsService#getAcledApiPolicy. Keeping the token refresh
// machinery mounted behind a disabled policy is deliberate: flipping this
// constant is the only change needed to enable API access, and the refresh path
// stays covered by tests in the meantime.
const (
	acledAPIEnabled        = false
	acledAPIDisabledReason = "Open myACLED does not include API access."
)

func exportRealtimeCronSources(effective *effectiveRealtimeSettings) RealtimeCronSources {
	return RealtimeCronSources{
		Opensky:         RealtimeCronSource{Enabled: effective.OpenskyEnabled, IntervalSec: effective.OpenskyIntervalSec},
		Ais:             RealtimeCronSource{Enabled: effective.AisEnabled, IntervalSec: effective.AisIntervalSec},
		Unrest:          RealtimeCronSource{Enabled: effective.UnrestEnabled, IntervalSec: effective.UnrestIntervalSec},
		Outages:         RealtimeCronSource{Enabled: effective.OutagesEnabled, IntervalSec: effective.OutagesIntervalSec},
		KeywordSpike:    RealtimeCronSource{Enabled: effective.KeywordSpikeEnabled, IntervalSec: effective.KeywordSpikeIntervalSec},
		Pizzint:         RealtimeCronSource{Enabled: effective.PizzintEnabled, IntervalSec: effective.PizzintIntervalSec},
		GdeltTension:    RealtimeCronSource{Enabled: effective.GdeltTensionEnabled, IntervalSec: effective.GdeltTensionIntervalSec},
		PolymarketLeads: RealtimeCronSource{Enabled: effective.PolymarketLeadsEnabled, IntervalSec: effective.PolymarketLeadsIntervalSec},
	}
}

// EffectiveRealtimeCronRuntime loads the settings (Redis cache, then MySQL) and
// resolves the complete collector configuration. refreshAcledToken selects the
// NestJS resolveAcledAccessToken mode: true is "if_needed" (the cron path), false
// is "none" (diagnostics and settings reads).
func (s *Service) EffectiveRealtimeCronRuntime(ctx context.Context, refreshAcledToken bool) (*RealtimeCronRuntime, error) {
	stored, err := s.loadRealtimeSettings(ctx)
	if err != nil {
		return nil, err
	}
	effective, err := s.resolveEffectiveSettings(stored)
	if err != nil {
		return nil, err
	}
	mode := acledRefreshNone
	if refreshAcledToken {
		mode = acledRefreshIfNeeded
	}
	resolvedToken, err := s.resolveAcledAccessToken(ctx, effective, mode)
	if err != nil {
		return nil, err
	}
	runtime := s.newRealtimeCronRuntime(effective)
	if acledAPIEnabled {
		runtime.Credentials.AcledAccessToken = resolvedToken.token
	}
	return runtime, nil
}

// EnvRealtimeCronRuntime resolves the environment-only fallback used when the
// stored settings cannot be read (RealtimeSignalsService.fromEnvConfig). The
// fallback never carries an ACLED token and always reports the API disabled.
func (s *Service) EnvRealtimeCronRuntime() *RealtimeCronRuntime {
	effective, err := s.resolveEffectiveSettings(nil)
	if err != nil {
		return nil
	}
	return s.newRealtimeCronRuntime(effective)
}

func (s *Service) newRealtimeCronRuntime(effective *effectiveRealtimeSettings) *RealtimeCronRuntime {
	return &RealtimeCronRuntime{
		Enabled:          effective.Enabled,
		RequestTimeoutMs: effective.RequestTimeoutMs,
		MaxRetries:       effective.MaxRetries,
		Capabilities: RealtimeCronCapabilities{
			AcledAPIEnabled:        acledAPIEnabled,
			AcledAPIDisabledReason: acledAPIDisabledReason,
		},
		Sources: exportRealtimeCronSources(effective),
		Thresholds: RealtimeCronThresholds{
			KeywordSpikeMinCount:            effective.KeywordSpikeMinCount,
			KeywordSpikeMultiplier:          effective.KeywordSpikeMultiplier,
			PredictionShiftThreshold:        effective.PredictionShiftThreshold,
			PredictionNewsActivityThreshold: effective.PredictionNewsActivityThreshold,
		},
		AisRelay: RealtimeCronAisRelay{
			BaseURL:      effective.AisRelayBaseURL,
			SharedSecret: effective.AisRelaySharedSecret,
		},
		Opensky: RealtimeCronOpensky{
			BaseURL:              effective.OpenskyBaseURL,
			TokenURL:             effective.OpenskyTokenURL,
			ClientID:             effective.OpenskyClientID,
			ClientSecret:         effective.OpenskyClientSecret,
			DailyCreditBudget:    effective.OpenskyDailyCreditBudget,
			DayIntervalSec:       effective.OpenskyDayIntervalSec,
			NightIntervalSec:     effective.OpenskyNightIntervalSec,
			DayStartHourHKT:      effective.OpenskyDayStartHourHKT,
			NightStartHourHKT:    effective.OpenskyNightStartHourHKT,
			WarningRemainingPct:  effective.OpenskyWarningRemainingPct,
			CriticalRemainingPct: effective.OpenskyCriticalRemainingPct,
		},
		Credentials: RealtimeCronCredentials{
			CloudflareAPIToken: effective.CloudflareAPIToken,
			WingbitsAPIKey:     effective.WingbitsAPIKey,
		},
		Polymarket: RealtimeCronPolymarket{ProxyURL: effective.PolymarketProxyURL},
	}
}

// ForceRefreshAcledAccessToken mirrors
// RealtimeSignalsSettingsService.forceRefreshAcledAccessToken: it returns "" when
// the ACLED API policy is disabled, and otherwise refreshes under the shared
// lock. The unrest collector calls it once after a 401/403.
func (s *Service) ForceRefreshAcledAccessToken(ctx context.Context) (string, error) {
	if !acledAPIEnabled {
		return "", nil
	}
	stored, err := s.loadRealtimeSettings(ctx)
	if err != nil {
		return "", err
	}
	effective, err := s.resolveEffectiveSettings(stored)
	if err != nil {
		return "", err
	}
	resolved, err := s.resolveAcledAccessToken(ctx, effective, acledRefreshForce)
	if err != nil {
		return "", err
	}
	return resolved.token, nil
}
