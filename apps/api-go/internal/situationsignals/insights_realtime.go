package situationsignals

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"os"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/situationinsights/analysis"
)

const (
	insightsRealtimeSettingsKey = "realtime_signals_settings"
	insightsRealtimeCacheKey    = "realtime-signals:settings"
	insightsRealtimeInsightKey  = "realtime-signals:insights:"
	insightsRealtimeLastRunKey  = "realtime-signals:last-run:"
)

type realtimeKeywordSpike struct {
	ID          string  `json:"id"`
	Term        string  `json:"term"`
	Count       float64 `json:"count"`
	Baseline    float64 `json:"baseline"`
	Multiplier  float64 `json:"multiplier"`
	SourceCount float64 `json:"sourceCount"`
	Confidence  float64 `json:"confidence"`
}

type realtimePredictionLead struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Shift        float64 `json:"shift"`
	NewsActivity float64 `json:"newsActivity"`
	Confidence   float64 `json:"confidence"`
}

type realtimeInsightSnapshot struct {
	KeywordSpikes   []realtimeKeywordSpike   `json:"keywordSpikes"`
	PredictionLeads []realtimePredictionLead `json:"predictionLeads"`
	Pizzint         *pizzintSnapshot         `json:"pizzint,omitempty"`
	Tensions        []tensionPair            `json:"tensions"`
}

type realtimeSourceConfig struct {
	Enabled     bool
	IntervalSec int
}

type realtimeRuntimeConfig struct {
	Enabled bool
	Sources map[string]realtimeSourceConfig
}

type storedRealtimeSettingsRaw struct {
	Enabled                    json.RawMessage `json:"enabled"`
	KeywordSpikeEnabled        json.RawMessage `json:"keywordSpikeEnabled"`
	KeywordSpikeIntervalSec    json.RawMessage `json:"keywordSpikeIntervalSec"`
	PizzintEnabled             json.RawMessage `json:"pizzintEnabled"`
	PizzintIntervalSec         json.RawMessage `json:"pizzintIntervalSec"`
	GdeltTensionEnabled        json.RawMessage `json:"gdeltTensionEnabled"`
	GdeltTensionIntervalSec    json.RawMessage `json:"gdeltTensionIntervalSec"`
	PolymarketLeadsEnabled     json.RawMessage `json:"polymarketLeadsEnabled"`
	PolymarketLeadsIntervalSec json.RawMessage `json:"polymarketLeadsIntervalSec"`
}

type realtimeSettingsEnvelope struct {
	Exists json.RawMessage `json:"exists"`
	Value  json.RawMessage `json:"value"`
}

// getRealtimeRuntimeConfig resolves the same effective settings the NestJS
// RealtimeSignalsSettingsService produces for the four insight sources. Only the
// fields the snapshot carry-forward reads are projected.
func (s *insightsService) getRealtimeRuntimeConfig(ctx context.Context) (realtimeRuntimeConfig, error) {
	config := realtimeRuntimeConfig{
		Enabled: envBoolDefault("REALTIME_SIGNALS_ENABLED", true),
		Sources: map[string]realtimeSourceConfig{
			"keyword_spike":    {Enabled: envBoolDefault("REALTIME_SIGNALS_KEYWORD_SPIKE_ENABLED", true), IntervalSec: envIntDefault("REALTIME_SIGNALS_KEYWORD_SPIKE_INTERVAL_SEC", 600)},
			"pizzint":          {Enabled: envBoolDefault("REALTIME_SIGNALS_PIZZINT_ENABLED", true), IntervalSec: envIntDefault("REALTIME_SIGNALS_PIZZINT_INTERVAL_SEC", 600)},
			"gdelt_tension":    {Enabled: envBoolDefault("REALTIME_SIGNALS_GDELT_TENSION_ENABLED", true), IntervalSec: envIntDefault("REALTIME_SIGNALS_GDELT_TENSION_INTERVAL_SEC", 600)},
			"polymarket_leads": {Enabled: envBoolDefault("REALTIME_SIGNALS_POLYMARKET_LEADS_ENABLED", true), IntervalSec: envIntDefault("REALTIME_SIGNALS_POLYMARKET_LEADS_INTERVAL_SEC", 600)},
		},
	}

	stored, err := s.loadRealtimeSettings(ctx)
	if err != nil {
		return config, err
	}
	if stored == nil {
		return config, nil
	}
	if value, ok := insightsBoolRaw(stored.Enabled); ok {
		config.Enabled = value
	}
	applyRealtimeBool := func(raw json.RawMessage, target *realtimeSourceConfig) {
		if value, ok := insightsBoolRaw(raw); ok {
			target.Enabled = value
		}
	}
	applyRealtimeInt := func(raw json.RawMessage, target *realtimeSourceConfig) {
		if value, ok := insightsBoundedIntRaw(raw, 30, 86_400); ok {
			target.IntervalSec = value
		}
	}
	keyword := config.Sources["keyword_spike"]
	applyRealtimeBool(stored.KeywordSpikeEnabled, &keyword)
	applyRealtimeInt(stored.KeywordSpikeIntervalSec, &keyword)
	config.Sources["keyword_spike"] = keyword
	pizzint := config.Sources["pizzint"]
	applyRealtimeBool(stored.PizzintEnabled, &pizzint)
	applyRealtimeInt(stored.PizzintIntervalSec, &pizzint)
	config.Sources["pizzint"] = pizzint
	tension := config.Sources["gdelt_tension"]
	applyRealtimeBool(stored.GdeltTensionEnabled, &tension)
	applyRealtimeInt(stored.GdeltTensionIntervalSec, &tension)
	config.Sources["gdelt_tension"] = tension
	polymarket := config.Sources["polymarket_leads"]
	applyRealtimeBool(stored.PolymarketLeadsEnabled, &polymarket)
	applyRealtimeInt(stored.PolymarketLeadsIntervalSec, &polymarket)
	config.Sources["polymarket_leads"] = polymarket
	return config, nil
}

func (s *insightsService) loadRealtimeSettings(ctx context.Context) (*storedRealtimeSettingsRaw, error) {
	if raw, found, err := s.cache.get(ctx, insightsRealtimeCacheKey); err != nil {
		return nil, err
	} else if found {
		var envelope realtimeSettingsEnvelope
		if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
			return nil, err
		}
		if !insightsJSONTruthy(envelope.Exists) {
			return nil, nil
		}
		if len(envelope.Value) == 0 || string(envelope.Value) == "null" {
			return nil, nil
		}
		var stored storedRealtimeSettingsRaw
		if err := json.Unmarshal(envelope.Value, &stored); err != nil {
			return nil, nil
		}
		return &stored, nil
	}
	if s.db == nil {
		return nil, nil
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ?", insightsRealtimeSettingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil, nil
	}
	var stored storedRealtimeSettingsRaw
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, nil
	}
	return &stored, nil
}

// getRealtimeInsightSnapshot mirrors RealtimeSignalsService.getSituationMonitorInsightSnapshot:
// runtime disabled -> empty; otherwise carry each enabled source forward only
// while its stored last-run is fresh. It never writes.
func (s *insightsService) getRealtimeInsightSnapshot(ctx context.Context, orgID string) (realtimeInsightSnapshot, error) {
	empty := realtimeInsightSnapshot{KeywordSpikes: []realtimeKeywordSpike{}, PredictionLeads: []realtimePredictionLead{}, Tensions: []tensionPair{}}
	runtime, err := s.getRealtimeRuntimeConfig(ctx)
	if err != nil {
		return empty, err
	}
	if !runtime.Enabled {
		return empty, nil
	}
	current := empty
	if raw, found, err := s.cache.get(ctx, insightsRealtimeInsightKey+orgID); err != nil {
		return empty, err
	} else if found && strings.TrimSpace(raw) != "null" {
		if err := json.Unmarshal([]byte(raw), &current); err != nil {
			return empty, err
		}
		if current.KeywordSpikes == nil {
			current.KeywordSpikes = []realtimeKeywordSpike{}
		}
		if current.PredictionLeads == nil {
			current.PredictionLeads = []realtimePredictionLead{}
		}
		if current.Tensions == nil {
			current.Tensions = []tensionPair{}
		}
	}
	next := empty
	nowMS := s.now().UnixMilli()
	for _, source := range []string{"keyword_spike", "polymarket_leads", "gdelt_tension", "pizzint"} {
		sourceConfig, ok := runtime.Sources[source]
		if !ok || !sourceConfig.Enabled {
			continue
		}
		lastRun, found, err := s.readRealtimeLastRun(ctx, orgID, source)
		if err != nil {
			return empty, err
		}
		if !found || !insightsFresh(lastRun, sourceConfig.IntervalSec, nowMS) {
			continue
		}
		switch source {
		case "keyword_spike":
			next.KeywordSpikes = current.KeywordSpikes
		case "polymarket_leads":
			next.PredictionLeads = current.PredictionLeads
		case "gdelt_tension":
			next.Tensions = current.Tensions
		case "pizzint":
			next.Pizzint = current.Pizzint
		}
	}
	return next, nil
}

func (s *insightsService) readRealtimeLastRun(ctx context.Context, orgID, source string) (int64, bool, error) {
	raw, found, err := s.cache.get(ctx, insightsRealtimeLastRunKey+orgID+":"+source)
	if err != nil || !found {
		return 0, false, err
	}
	var value float64
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return 0, false, nil
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false, nil
	}
	return int64(value), true, nil
}

func insightsFresh(lastRunMS int64, intervalSec int, nowMS int64) bool {
	safeInterval := intervalSec
	if safeInterval < 10 {
		safeInterval = 10
	}
	freshness := int64(5 * 60 * 1000)
	if candidate := int64(safeInterval) * 2 * 1000; candidate > freshness {
		freshness = candidate
	}
	return nowMS-lastRunMS <= freshness
}

func buildRealtimePredictiveSignals(snapshot realtimeInsightSnapshot) []analysis.PredictiveSignal {
	out := make([]analysis.PredictiveSignal, 0, len(snapshot.KeywordSpikes)+len(snapshot.PredictionLeads))
	for _, spike := range snapshot.KeywordSpikes {
		confidence := clampConfidence(spike.Confidence)
		out = append(out, analysis.PredictiveSignal{
			ID:         "keyword_spike:" + spike.ID,
			Name:       "Keyword Spike · " + spike.Term,
			Category:   "Realtime",
			Score:      roundToThree(spike.Multiplier*10 + spike.Count),
			Confidence: confidence,
			Prediction: "Cross-source headline velocity indicates emerging narrative pressure.",
			Level:      confidenceLevel(confidence),
			Headlines:  []analysis.SignalHeadline{},
		})
	}
	for _, lead := range snapshot.PredictionLeads {
		confidence := clampConfidence(lead.Confidence)
		out = append(out, analysis.PredictiveSignal{
			ID:         "prediction_leads_news:" + lead.ID,
			Name:       "Prediction Leads · " + lead.Title,
			Category:   "Realtime",
			Score:      roundToThree(lead.Shift*10 + (3 - math.Min(3, lead.NewsActivity))),
			Confidence: confidence,
			Prediction: "Market pricing moved ahead of mainstream coverage; watch for delayed narrative pickup.",
			Level:      confidenceLevel(confidence),
			Headlines:  []analysis.SignalHeadline{},
		})
	}
	sortPredictiveSignals(out)
	return out
}

func mergeRealtimeCorrelation(correlation *analysis.CorrelationResults, realtime []analysis.PredictiveSignal) *analysis.CorrelationResults {
	if correlation != nil {
		correlation.PredictiveSignals = append(correlation.PredictiveSignals, realtime...)
		return correlation
	}
	if len(realtime) == 0 {
		return nil
	}
	return &analysis.CorrelationResults{
		EmergingPatterns:        []analysis.EmergingPattern{},
		MomentumSignals:         []analysis.MomentumSignal{},
		CrossSourceCorrelations: []analysis.CrossSourceCorrelation{},
		PredictiveSignals:       realtime,
	}
}

func clampConfidence(value float64) int {
	scaled := math.Round(value * 100)
	if scaled < 0 {
		return 0
	}
	if scaled > 100 {
		return 100
	}
	return int(scaled)
}

func confidenceLevel(score int) string {
	if score >= 70 {
		return "high"
	}
	if score >= 50 {
		return "medium"
	}
	return "low"
}

func roundToThree(value float64) float64 {
	return math.Round(value*1000) / 1000
}

func sortPredictiveSignals(values []analysis.PredictiveSignal) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j].Score > values[j-1].Score; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

func envBoolDefault(key string, fallback bool) bool {
	raw, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	if parsed := parseInsightsBoolean(raw); parsed != nil {
		return *parsed
	}
	return fallback
}

func envIntDefault(key string, fallback int) int {
	raw, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	value, valid := insightsInt(raw)
	if !valid || value <= 0 {
		return fallback
	}
	return value
}

func insightsBoolRaw(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return false, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, false
	}
	return value, true
}

func insightsBoundedIntRaw(raw json.RawMessage, min, max int) (int, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	// NestJS asBoundedInt truncates and then clamps an explicit stored value;
	// only a non-numeric member falls back to the environment default.
	rounded := int(math.Trunc(value))
	if rounded < min {
		return min, true
	}
	if rounded > max {
		return max, true
	}
	return rounded, true
}

func insightsJSONTruthy(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" || trimmed == "false" || trimmed == "0" {
		return false
	}
	if trimmed == `""` {
		return false
	}
	return true
}
