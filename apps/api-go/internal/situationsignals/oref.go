package situationsignals

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// orefCachedState is the normalized cached OREF state.
//
// Only two writes ever populate it: the cached alerts document supplies the
// alert list, the poll timestamp and the error, while the cached history
// document supplies the history list and both counters. The counters are
// therefore zero whenever the history cache entry is absent, which is the
// behaviour NestJS has (restoreCachedOrefState only assigns them on the history
// branch).
type orefCachedState struct {
	Alerts            []rawJSON
	History           []rawJSON
	HistoryCount24h   float64
	TotalHistoryCount float64
	LastPollAt        float64
	LastError         *string
}

// orefAlertsDocument is the cached alerts response document.
type orefAlertsDocument struct {
	Alerts    rawJSON `json:"alerts"`
	Timestamp rawJSON `json:"timestamp"`
	Error     rawJSON `json:"error"`
}

// orefHistoryDocument is the cached history response document.
type orefHistoryDocument struct {
	History           rawJSON     `json:"history"`
	HistoryCount24h   jsNumberish `json:"historyCount24h"`
	TotalHistoryCount jsNumberish `json:"totalHistoryCount"`
}

// loadCachedOrefState mirrors restoreCachedOrefState.
func (s *Service) loadCachedOrefState(ctx context.Context) orefCachedState {
	state := orefCachedState{Alerts: []rawJSON{}, History: []rawJSON{}}
	if s == nil || s.cache.get == nil {
		return state
	}
	alertsRaw, alertsErr := s.cache.get(ctx, orefAlertsKey)
	historyRaw, historyErr := s.cache.get(ctx, orefHistoryKey)
	if alertsErr != nil && !errors.Is(alertsErr, redis.Nil) {
		log.Printf("situationsignals: oref alerts cache read failed: %v", alertsErr)
		alertsRaw = ""
	}
	if historyErr != nil && !errors.Is(historyErr, redis.Nil) {
		log.Printf("situationsignals: oref history cache read failed: %v", historyErr)
		historyRaw = ""
	}

	if alertsRaw != "" {
		var document orefAlertsDocument
		if err := json.Unmarshal([]byte(alertsRaw), &document); err == nil {
			if values, ok := document.Alerts.asArray(); ok {
				state.Alerts = wrapRawJSON(values)
			}
			// Date.parse(timestamp) || 0: an unparseable timestamp is 0, which the
			// response then renders as "now".
			if parsed, ok := parseJSTime(document.Timestamp); ok {
				state.LastPollAt = float64(parsed.UnixMilli())
			}
			if message, ok := document.Error.asString(); ok {
				state.LastError = &message
			}
		}
	}

	if historyRaw != "" {
		var document orefHistoryDocument
		if err := json.Unmarshal([]byte(historyRaw), &document); err == nil {
			if values, ok := document.History.asArray(); ok {
				state.History = wrapRawJSON(values)
				state.HistoryCount24h = numberOrZero(document.HistoryCount24h)
				state.TotalHistoryCount = numberOrZero(document.TotalHistoryCount)
			}
		}
	}
	return state
}

// orefAlertsResponse is the GET /oref-alerts body.
type orefAlertsResponse struct {
	Scope             string        `json:"scope"`
	Configured        bool          `json:"configured"`
	Alerts            []rawJSON     `json:"alerts"`
	HistoryCount24h   float64       `json:"historyCount24h"`
	TotalHistoryCount float64       `json:"totalHistoryCount"`
	Timestamp         string        `json:"timestamp"`
	Error             string        `json:"error,omitempty"`
	MonitorMatches    []matchResult `json:"monitorMatches"`
}

// orefHistoryResponse is the GET /oref-history body.
type orefHistoryResponse struct {
	Scope             string        `json:"scope"`
	Configured        bool          `json:"configured"`
	History           []rawJSON     `json:"history"`
	HistoryCount24h   float64       `json:"historyCount24h"`
	TotalHistoryCount float64       `json:"totalHistoryCount"`
	Timestamp         string        `json:"timestamp"`
	Error             string        `json:"error,omitempty"`
	MonitorMatches    []matchResult `json:"monitorMatches"`
}

// getOrefAlerts mirrors getOrefAlerts plus augmentOrefAlerts.
func (s *Service) getOrefAlerts(ctx context.Context, orgID, userID string) (orefAlertsResponse, error) {
	state := s.loadCachedOrefState(ctx)
	response := orefAlertsResponse{
		Scope:             "global",
		Configured:        s.settings.orefConfigured(),
		Alerts:            state.Alerts,
		HistoryCount24h:   state.HistoryCount24h,
		TotalHistoryCount: state.TotalHistoryCount,
		Timestamp:         currentOrCachedTimestamp(state.LastPollAt),
	}
	if state.LastError != nil {
		response.Error = *state.LastError
	}
	candidates := make([]monitorCandidate, 0, len(state.Alerts))
	for _, alert := range state.Alerts {
		candidates = append(candidates, orefAlertCandidate(alert, "oref_alert"))
	}
	matches, err := s.matchCandidates(ctx, orgID, userID, candidates)
	if err != nil {
		return orefAlertsResponse{}, err
	}
	response.MonitorMatches = matches
	return response, nil
}

// getOrefHistory mirrors getOrefHistory plus augmentOrefHistory.
func (s *Service) getOrefHistory(ctx context.Context, orgID, userID string) (orefHistoryResponse, error) {
	state := s.loadCachedOrefState(ctx)
	response := orefHistoryResponse{
		Scope:             "global",
		Configured:        s.settings.orefConfigured(),
		History:           state.History,
		HistoryCount24h:   state.HistoryCount24h,
		TotalHistoryCount: state.TotalHistoryCount,
		Timestamp:         currentOrCachedTimestamp(state.LastPollAt),
	}
	if state.LastError != nil {
		response.Error = *state.LastError
	}
	candidates := make([]monitorCandidate, 0)
	for _, entry := range state.History {
		var fields orefHistoryEntryFields
		if err := json.Unmarshal(entry.raw, &fields); err != nil {
			continue
		}
		alerts, ok := fields.Alerts.asArray()
		if !ok {
			continue
		}
		for _, alert := range alerts {
			candidates = append(candidates, orefHistoryCandidate(rawJSON{raw: alert}, entry))
		}
	}
	matches, err := s.matchCandidates(ctx, orgID, userID, candidates)
	if err != nil {
		return orefHistoryResponse{}, err
	}
	response.MonitorMatches = matches
	return response, nil
}

// currentOrCachedTimestamp mirrors
// `lastPollAt ? new Date(lastPollAt).toISOString() : new Date().toISOString()`.
// A stateless response carries the current instant and is therefore not
// deterministic; the smoke workflow always seeds lastPollAt.
func currentOrCachedTimestamp(lastPollAt float64) string {
	if lastPollAt != 0 {
		return nestISOTime(lastPollAt)
	}
	return nestISOTime(float64(time.Now().UnixMilli()))
}
