package situationsignalsworker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
)

// OREF response and bootstrap constants.
const (
	// maxOrefAlertsResponseBytes mirrors the curl maxBuffer of 2 MiB for the
	// alerts request (NestJS orefCurlFetch without -o toFile captures stdout).
	// The history request uses curl -o <tmpfile>, whose maxBuffer only bounds the
	// empty stdout, so it has no body limit and is fetched with maxBytes 0.
	maxOrefAlertsResponseBytes = 2 * 1024 * 1024
	// orefHistoryBootstrapLimit is the `parsed.slice(0, 500)` cap.
	orefHistoryBootstrapLimit = 500
	// orefAlertsURLReferer and the two request headers mirror orefCurlFetch.
	orefAlertsReferer      = "https://www.oref.org.il/"
	orefAcceptHeader       = "application/json"
	orefRequestedWith      = "XMLHttpRequest"
	orefHistoryDatePattern = `[^0-9]`
)

const (
	orefDisabledMessage   = "OREF polling is disabled"
	orefNotConfiguredText = "OREF proxy credentials are not configured"
	orefProxyMissingText  = "OREF proxy credentials are missing"
)

var orefHistoryDateCleaner = regexp.MustCompile(orefHistoryDatePattern)

// orefHistoryAlert is the alert object bootstrapOrefHistoryFromUpstream builds.
// Field order id, cat, title, data, desc, alertDate is the NestJS literal order.
type orefHistoryAlert struct {
	ID        string   `json:"id"`
	Cat       string   `json:"cat"`
	Title     string   `json:"title"`
	Data      []string `json:"data"`
	Desc      string   `json:"desc"`
	AlertDate string   `json:"alertDate"`
}

// pollOref mirrors pollOrefOnce with the B1/B3 fixes.
func (s *Service) pollOref(ctx context.Context) error {
	state, err := s.loadOrefState(ctx)
	if err != nil {
		return err
	}
	// B1: the cached documents are the data source. A failed poll is never
	// persisted (B3), so a process-local error survives the refresh until the
	// next successful poll clears it.
	if state.LastError == "" {
		state.LastError = s.orefState.LastError
	}
	s.orefState = state

	if !s.env.OrefEnabled {
		s.orefState.LastError = orefDisabledMessage
		return nil
	}
	proxyAuth := strings.TrimSpace(s.env.OrefProxyAuth)
	if proxyAuth == "" {
		s.orefState.LastError = orefNotConfiguredText
		return nil
	}

	if !s.orefBootstrapped {
		if s.bootstrapOrefHistoryWithRetry(ctx) {
			s.orefBootstrapped = true
		}
	}

	body, err := s.fetchOref(ctx, s.env.OrefAlertsURL, proxyAuth, maxOrefAlertsResponseBytes)
	if err != nil {
		s.orefState.LastError = redactOrefError(err.Error())
		s.logf("situationsignalsworker: OREF poll failed: %s", s.orefState.LastError)
		return nil
	}
	alerts, err := parseOrefAlertsResponse(body)
	if err != nil {
		// B3: a non-empty body that is not JSON is a failure, not "no alerts".
		s.orefState.LastError = redactOrefError(err.Error())
		s.logf("situationsignalsworker: OREF poll failed: %s", s.orefState.LastError)
		return nil
	}

	newJSON := marshalAlerts(alerts)
	changed := newJSON != s.orefState.LastAlertsJSON

	s.orefState.LastAlerts = alerts
	s.orefState.LastAlertsJSON = newJSON
	s.orefState.LastPollAt = s.now().UnixMilli()
	s.orefState.LastError = ""

	var historyEntry *OrefHistoryEntry
	if changed && len(alerts) > 0 {
		entry := OrefHistoryEntry{
			Alerts:    alerts,
			Timestamp: nestISOTimeMillis(s.now().UnixMilli()),
		}
		s.orefState.History = append(s.orefState.History, entry)
		historyEntry = &entry
	}

	s.recomputeOrefHistoryCounts(s.now())
	timestamp := orefDocumentTimestamp(s.orefState.LastPollAt, s.now())
	s.persistOrefAlerts(ctx, s.orefState, true, timestamp)
	s.persistOrefHistory(ctx, s.orefState, true, timestamp, s.env.OrefHistoryMaxWaves)
	s.persistOrefMetrics(ctx, s.orefState, timestamp)

	if changed {
		payload := orefUpdatePayload{
			Alerts:            s.orefState.LastAlerts,
			HistoryCount24h:   s.orefState.HistoryCount24h,
			TotalHistoryCount: s.orefState.TotalHistoryCount,
			UpdatedAt:         timestamp,
			HistoryEntry:      historyEntry,
		}
		s.publishEvent(ctx, RealtimeEventOrefUpdate, payload)
	}

	if err := s.triggerOrefAlertChecks(ctx); err != nil {
		// NestJS runs the alert-rule maintenance inside pollOrefOnce's try, so a
		// failure there is recorded in lastError after the cache documents and the
		// event have already been written.
		s.orefState.LastError = redactOrefError(err.Error())
		s.logf("situationsignalsworker: OREF alert rule maintenance failed: %s", s.orefState.LastError)
	}
	return nil
}

// orefDocumentTimestamp mirrors the NestJS persisted `timestamp` expression:
// the cached poll instant when one exists, otherwise the current instant.
func orefDocumentTimestamp(lastPollAt int64, now time.Time) string {
	if lastPollAt != 0 {
		return nestISOTimeMillis(lastPollAt)
	}
	return nestISOTimeMillis(now.UnixMilli())
}

// fetchOref performs one OREF HTTP GET with the same proxy, timeout and headers
// as orefCurlFetch, but through net/http instead of exec'ing curl.
//
// maxBytes > 0 bounds the response body (the alerts request mirrors curl's 2 MiB
// maxBuffer); maxBytes == 0 reads the body without a size limit, which is what
// the history request needs because NestJS downloads it with curl -o <tmpfile>.
func (s *Service) fetchOref(ctx context.Context, rawURL, proxyAuth string, maxBytes int64) ([]byte, error) {
	client := s.orefHTTP
	if client == nil {
		var err error
		client, err = s.newOrefHTTPClient(proxyAuth)
		if err != nil {
			return nil, err
		}
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build OREF request: %w", err)
	}
	request.Header.Set("Accept", orefAcceptHeader)
	request.Header.Set("Referer", orefAlertsReferer)
	request.Header.Set("X-Requested-With", orefRequestedWith)

	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("OREF request failed: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	// B3: a non-2xx response is a failed poll. curl without -f returned the
	// error page body and NestJS parsed it as an empty alert list.
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, fmt.Errorf("OREF request failed with HTTP status %d", response.StatusCode)
	}

	if maxBytes > 0 {
		body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
		if err != nil {
			return nil, fmt.Errorf("read OREF response: %w", err)
		}
		if int64(len(body)) > maxBytes {
			return nil, fmt.Errorf("OREF response exceeded %d bytes", maxBytes)
		}
		return body, nil
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read OREF response: %w", err)
	}
	return body, nil
}

// newOrefHTTPClient builds the per-poll client: the OREF proxy with Basic auth
// and the curl --max-time equivalent as total timeout.
func (s *Service) newOrefHTTPClient(proxyAuth string) (*http.Client, error) {
	proxyURL, err := url.Parse("http://" + proxyAuth)
	if err != nil || proxyURL.Host == "" {
		return nil, fmt.Errorf("%s", orefProxyMissingText)
	}
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		transport = &http.Transport{}
	}
	cloned := transport.Clone()
	cloned.Proxy = http.ProxyURL(proxyURL)
	return &http.Client{
		Transport: cloned,
		Timeout:   time.Duration(s.env.OrefCurlTimeoutSeconds) * time.Second,
		// curl without -L does not follow redirects; a 3xx is a non-2xx body
		// (and therefore a B3 failure) rather than a transparent follow.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}, nil
}

// parseOrefAlertsResponse mirrors the response parsing of pollOrefOnce with the
// B3 fix: a non-empty body that is not valid JSON is an error. An empty body,
// "[]" and "null" mean "no active alerts"; a valid JSON array is the alert
// list, a valid JSON object is one alert and any other valid JSON scalar leaves
// the list empty (the NestJS JSON.parse branch).
func parseOrefAlertsResponse(body []byte) ([]json.RawMessage, error) {
	cleaned := strings.TrimSpace(stripBOM(string(body)))
	if cleaned == "" || cleaned == "[]" || cleaned == "null" {
		return []json.RawMessage{}, nil
	}
	trimmed := bytes.TrimSpace([]byte(cleaned))
	switch trimmed[0] {
	case '[':
		var values []json.RawMessage
		if err := json.Unmarshal(trimmed, &values); err != nil {
			return nil, fmt.Errorf("parse OREF alerts: %w", err)
		}
		compacted := make([]json.RawMessage, 0, len(values))
		for _, value := range values {
			encoded, err := compactJSON(value)
			if err != nil {
				return nil, fmt.Errorf("parse OREF alert: %w", err)
			}
			compacted = append(compacted, encoded)
		}
		return compacted, nil
	case '{':
		var value json.RawMessage
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return nil, fmt.Errorf("parse OREF alerts: %w", err)
		}
		encoded, err := compactJSON(value)
		if err != nil {
			return nil, fmt.Errorf("parse OREF alerts: %w", err)
		}
		return []json.RawMessage{encoded}, nil
	default:
		if !json.Valid(trimmed) {
			return nil, fmt.Errorf("parse OREF alerts: invalid JSON body")
		}
		return []json.RawMessage{}, nil
	}
}

// recomputeOrefHistoryCounts mirrors recomputeOrefHistoryCounts: purge entries
// outside the retention window, then count alert areas in the 24h and full
// windows. An unparseable entry timestamp is dropped by the purge filter, which
// is what the NestJS `Number.isFinite(ts) && ts > purgeCutoff` test does.
func (s *Service) recomputeOrefHistoryCounts(now time.Time) {
	retentionDays := s.env.OrefHistoryRetention
	nowMillis := now.UnixMilli()
	cutoff24h := nowMillis - 24*60*60*1000
	purgeCutoff := nowMillis - int64(retentionDays)*24*60*60*1000

	kept := make([]OrefHistoryEntry, 0, len(s.orefState.History))
	historyCount24h := 0
	totalHistoryCount := 0
	for _, entry := range s.orefState.History {
		timestamp, ok := parseJSTimeString(entry.Timestamp)
		if !ok || timestamp <= purgeCutoff {
			continue
		}
		kept = append(kept, entry)
		areas := countAlertAreas(entry.Alerts)
		totalHistoryCount += areas
		if timestamp > cutoff24h {
			historyCount24h += areas
		}
	}
	s.orefState.History = kept
	s.orefState.HistoryCount24h = historyCount24h
	s.orefState.TotalHistoryCount = totalHistoryCount
}

// countAlertAreas mirrors countAlertAreas: the length of alert.data when it is
// a non-empty array, otherwise 1.
func countAlertAreas(alerts []json.RawMessage) int {
	total := 0
	for _, alert := range alerts {
		var fields struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(alert, &fields); err != nil {
			total++
			continue
		}
		var data []json.RawMessage
		if err := json.Unmarshal(fields.Data, &data); err != nil || len(data) == 0 {
			total++
			continue
		}
		total += len(data)
	}
	return total
}

// bootstrapOrefHistoryWithRetry mirrors bootstrapOrefHistoryWithRetry: adopt
// the cached history when it exists, otherwise fetch the upstream history with
// OREF_BOOTSTRAP_MAX_RETRIES attempts and exponential backoff.
func (s *Service) bootstrapOrefHistoryWithRetry(ctx context.Context) bool {
	cached, found, err := s.persistedOrefHistory(ctx)
	if err != nil {
		s.logf("situationsignalsworker: read cached OREF history failed: %v", err)
	} else if found {
		s.orefState.History = cached.History
		s.orefState.HistoryCount24h = cached.HistoryCount24h
		s.orefState.TotalHistoryCount = cached.TotalHistoryCount
		if parsed, ok := parseJSTimeString(cached.Timestamp); ok && parsed != 0 {
			s.orefState.LastPollAt = parsed
		}
		s.orefState.BootstrapSource = "cache"
		return true
	}

	maxAttempts := s.env.OrefBootstrapRetries
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := s.bootstrapOrefHistoryFromUpstream(ctx); err != nil {
			if attempt >= maxAttempts {
				s.logf("situationsignalsworker: OREF history bootstrap exhausted all retries: %v", err)
				return false
			}
			delay := 3_000*(1<<uint(attempt-1)) + rand.Intn(800)
			if err := sleepContext(ctx, time.Duration(delay)*time.Millisecond); err != nil {
				return false
			}
			continue
		}
		s.orefState.BootstrapSource = "upstream"
		s.persistOrefHistory(ctx, s.orefState, strings.TrimSpace(s.env.OrefProxyAuth) != "",
			orefDocumentTimestamp(s.orefState.LastPollAt, s.now()), s.env.OrefHistoryMaxWaves)
		return true
	}
	return false
}

// bootstrapOrefHistoryFromUpstream mirrors bootstrapOrefHistoryFromUpstream:
// fetch the alert history, group the records into one wave per alertDate and
// replace the in-memory history with the rebuilt list.
func (s *Service) bootstrapOrefHistoryFromUpstream(ctx context.Context) error {
	proxyAuth := strings.TrimSpace(s.env.OrefProxyAuth)
	body, err := s.fetchOref(ctx, s.env.OrefHistoryURL, proxyAuth, 0)
	if err != nil {
		return err
	}
	cleaned := strings.TrimSpace(stripBOM(string(body)))
	if cleaned == "" || cleaned == "[]" || cleaned == "null" {
		return nil
	}
	trimmed := bytes.TrimSpace([]byte(cleaned))
	var records []json.RawMessage
	switch trimmed[0] {
	case '[':
		if err := json.Unmarshal(trimmed, &records); err != nil {
			return fmt.Errorf("parse OREF history: %w", err)
		}
	default:
		if !json.Valid(trimmed) {
			return fmt.Errorf("parse OREF history: invalid JSON body")
		}
		// A valid non-array body means no records, exactly like
		// `Array.isArray(parsed) ? parsed.slice(0, 500) : []`.
		records = nil
	}
	if len(records) > orefHistoryBootstrapLimit {
		records = records[:orefHistoryBootstrapLimit]
	}

	waves := make(map[string][]json.RawMessage)
	order := make([]string, 0, len(records))
	typeIndex := 0
	for _, record := range records {
		recordTrimmed := bytes.TrimSpace(record)
		if len(recordTrimmed) == 0 || recordTrimmed[0] != '{' {
			continue
		}
		var fields struct {
			AlertDate json.RawMessage `json:"alertDate"`
			Category  json.RawMessage `json:"category"`
			Title     json.RawMessage `json:"title"`
			Data      json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(recordTrimmed, &fields); err != nil {
			continue
		}
		alertDate, ok := jsonStringPointer(fields.AlertDate)
		if !ok || alertDate == "" {
			continue
		}
		if _, seen := waves[alertDate]; !seen {
			waves[alertDate] = make([]json.RawMessage, 0, 6)
			order = append(order, alertDate)
		}

		category, hasCategory := jsStringOrNull(fields.Category, "")
		title, hasTitle := jsStringOrNull(fields.Title, "")
		if !hasTitle {
			title = category
		}
		data := make([]string, 0, 1)
		if !jsonValueIsNull(fields.Data) {
			if value := jsStringOr(fields.Data, ""); value != "" {
				data = append(data, value)
			}
		}
		categoryForID := category
		if !hasCategory {
			categoryForID = "cat"
		}
		alert := orefHistoryAlert{
			ID:        categoryForID + "-" + intString(int64(typeIndex)) + "-" + orefHistoryDateCleaner.ReplaceAllString(alertDate, ""),
			Cat:       category,
			Title:     title,
			Data:      data,
			Desc:      "",
			AlertDate: alertDate,
		}
		encoded, err := marshalJSONNoEscape(alert)
		if err != nil {
			continue
		}
		waves[alertDate] = append(waves[alertDate], encoded)
		typeIndex++
	}

	history := make([]OrefHistoryEntry, 0, len(order))
	for _, date := range order {
		history = append(history, OrefHistoryEntry{
			Alerts:    waves[date],
			Timestamp: situationsignals.OrefDateToUTC(date),
		})
	}
	sort.SliceStable(history, func(left, right int) bool {
		return history[left].Timestamp < history[right].Timestamp
	})

	s.orefState.History = history
	s.recomputeOrefHistoryCounts(s.now())
	return nil
}

// jsStringOrNull mirrors `String(value)` and reports whether the value was
// present and non-null, which backs the `record.title ?? record.category ?? ""`
// fallback chain of the bootstrap parser. Numbers and booleans use their
// JavaScript string form.
func jsStringOrNull(raw json.RawMessage, fallback string) (string, bool) {
	if jsonValueIsNull(raw) {
		return fallback, false
	}
	return jsStringOr(raw, fallback), true
}

// jsonStringPointer decodes a raw JSON string and reports whether the value was
// a string.
func jsonStringPointer(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return "", false
	}
	return value, true
}

// sleepContext waits for the duration or the caller's cancellation.
func sleepContext(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
