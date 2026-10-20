package gdeltsnapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GDELT DOC 2.0 endpoint and request limits. GDELT_MAX_RECORDS is the hard cap
// the NestJS service applies on top of the per-category limit.
const (
	gdeltDoc2URL        = "https://api.gdeltproject.org/api/v2/doc/doc"
	gdeltMaxRecords     = 25
	gdeltAcceptValue    = "application/json"
	gdeltFallbackSource = "GDELT"
)

// categoryQueries is the broad free-text query of every category. GDELT ranks by
// relevance; these are only topic signals, not theme filters.
var categoryQueries = map[Category]string{
	CategoryPolitics: `"politics" OR "election" OR "diplomacy" OR "government" OR "parliament"`,
	CategoryTech:     `"technology" OR "cyber" OR "semiconductor" OR "big tech" OR "startup"`,
	CategoryFinance:  `"finance" OR "economy" OR "markets" OR "trade" OR "inflation" OR "central bank"`,
	CategoryGov:      `"government" OR "policy" OR "regulation" OR "legislation" OR "cabinet"`,
	CategoryAI:       `"artificial intelligence" OR "machine learning" OR "generative ai" OR "llm"`,
	CategoryIntel:    `"intelligence" OR "espionage" OR "military" OR "defense" OR "nato"`,
}

// seenDatePattern is the GDELT seendate shape, "20240812T143000Z".
var seenDatePattern = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$`)

// gdeltArticle is the tolerant projection of one entry of the GDELT response.
// Every member is raw because GDELT occasionally emits numbers or nulls where
// the NestJS parser expects strings.
type gdeltArticle struct {
	URL      json.RawMessage `json:"url"`
	Title    json.RawMessage `json:"title"`
	Source   json.RawMessage `json:"source"`
	Domain   json.RawMessage `json:"domain"`
	SeenDate json.RawMessage `json:"seendate"`
}

// gdeltDocument is the DOC 2.0 artlist response.
type gdeltDocument struct {
	Articles []gdeltArticle `json:"articles"`
}

// fetchOutcome is one category fetch: the usable headlines plus the warning the
// caller turns into a category state and a snapshot warning.
type fetchOutcome struct {
	headlines []Headline
	warning   *Warning
}

// gdeltFetcher issues the category requests. The primary client keeps the
// platform default dialing behavior; the IPv4 client forces an IPv4 dial so a
// broken IPv6 path can be retried, mirroring fetchWithIpv4Fallback.
type gdeltFetcher struct {
	doc2URL  string
	timeout  time.Duration
	now      func() time.Time
	primary  *http.Client
	ipv4Only *http.Client
}

// newGDeltFetcher builds the production fetcher: real HTTP clients, a single
// IPv4 fallback attempt per request and the shared clock.
func newGDeltFetcher(now func() time.Time) *gdeltFetcher {
	ipv4Transport := http.DefaultTransport.(*http.Transport).Clone()
	ipv4Transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
		dialer := &net.Dialer{}
		return dialer.DialContext(ctx, "tcp4", address)
	}
	return &gdeltFetcher{
		doc2URL:  gdeltDoc2URL,
		timeout:  fetchTimeout,
		now:      now,
		primary:  &http.Client{},
		ipv4Only: &http.Client{Transport: ipv4Transport},
	}
}

// fetchCategory requests one category and classifies the result exactly like
// fetchGdeltCategoryHeadlines: 429 is gdelt_rate_limited, any other non-2xx is
// gdelt_http_error, a transport or decode failure is gdelt_fetch_failed and an
// empty result is gdelt_empty. No retry happens beyond the single IPv4
// fallback.
func (f *gdeltFetcher) fetchCategory(ctx context.Context, category Category, limit int) fetchOutcome {
	maxRecords := limit
	if maxRecords < 1 {
		maxRecords = 1
	}
	if maxRecords > gdeltMaxRecords {
		maxRecords = gdeltMaxRecords
	}
	target := f.categoryURL(category, maxRecords)

	response, cancel, err := f.do(ctx, target, f.primary)
	if err != nil && ctx.Err() == nil {
		// A caller cancellation is never retried, matching
		// shouldRetryWithIpv4's AbortError branch. Any other transport failure
		// gets one IPv4 attempt with a fresh timeout budget.
		response, cancel, err = f.do(ctx, target, f.ipv4Only)
	}
	if err != nil {
		return fetchOutcome{warning: f.fetchFailedWarning(err)}
	}
	defer cancel()
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode == http.StatusTooManyRequests {
		return fetchOutcome{warning: &Warning{
			Code:     codeRateLimited,
			Severity: severityWarning,
			Message:  "GDELT is rate limiting requests",
			Detail:   fmt.Sprintf("HTTP %d", response.StatusCode),
		}}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fetchOutcome{warning: &Warning{
			Code:     codeHTTPError,
			Severity: severityWarning,
			Message:  fmt.Sprintf("GDELT request failed with HTTP %d", response.StatusCode),
		}}
	}

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return fetchOutcome{warning: f.fetchFailedWarning(err)}
	}
	var document gdeltDocument
	if err := json.Unmarshal(body, &document); err != nil {
		return fetchOutcome{warning: f.fetchFailedWarning(err)}
	}

	headlines := make([]Headline, 0, maxRecords)
	seen := make(map[string]struct{}, len(document.Articles))
	for _, article := range document.Articles {
		title, _ := jsonString(article.Title)
		title = strings.TrimSpace(title)
		link, _ := jsonString(article.URL)
		link = strings.TrimSpace(link)
		if title == "" || link == "" {
			continue
		}
		if _, duplicate := seen[link]; duplicate {
			continue
		}
		seen[link] = struct{}{}

		headlines = append(headlines, Headline{
			ID:        "gdelt:" + link,
			Title:     title,
			Link:      link,
			Source:    articleSource(article),
			Timestamp: f.parseSeenDate(article.SeenDate),
			Category:  category,
			Origin:    headlineOrigin,
			IsAlert:   false,
		})
		if len(headlines) >= maxRecords {
			break
		}
	}

	if len(headlines) == 0 {
		return fetchOutcome{warning: &Warning{
			Code:     codeEmpty,
			Severity: severityInfo,
			Message:  "GDELT returned no articles for this category",
		}}
	}
	return fetchOutcome{headlines: headlines}
}

// categoryURL builds the request URL with the same parameters and the same
// order as the NestJS URLSearchParams call. The order is kept even though GDELT
// does not depend on it, so the request line matches byte for byte.
func (f *gdeltFetcher) categoryURL(category Category, maxRecords int) string {
	params := []struct {
		name  string
		value string
	}{
		{"query", categoryQueries[category]},
		{"mode", "artlist"},
		{"maxrecords", strconv.Itoa(maxRecords)},
		{"timespan", "24h"},
		{"format", "json"},
		{"lang", "eng"},
	}
	var builder strings.Builder
	builder.WriteString(f.doc2URL)
	builder.WriteByte('?')
	for index, param := range params {
		if index > 0 {
			builder.WriteByte('&')
		}
		builder.WriteString(url.QueryEscape(param.name))
		builder.WriteByte('=')
		builder.WriteString(url.QueryEscape(param.value))
	}
	return builder.String()
}

// do issues one attempt with its own timeout budget. The returned cancel
// function must be called after the body has been read so the deadline covers
// the whole exchange.
func (f *gdeltFetcher) do(ctx context.Context, target string, client *http.Client) (*http.Response, context.CancelFunc, error) {
	attemptCtx, cancel := context.WithTimeout(ctx, f.timeout)
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, target, nil)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	request.Header.Set("Accept", gdeltAcceptValue)
	response, err := client.Do(request)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	return response, cancel, nil
}

// fetchFailedWarning classifies a transport failure. A timeout keeps the NestJS
// message so the stored warning detail matches; anything else carries the Go
// error text.
func (f *gdeltFetcher) fetchFailedWarning(err error) *Warning {
	detail := err.Error()
	if isTimeoutError(err) {
		detail = fmt.Sprintf("Network request timed out after %dms", f.timeout.Milliseconds())
	}
	return &Warning{
		Code:     codeFetchFailed,
		Severity: severityWarning,
		Message:  "GDELT request failed",
		Detail:   detail,
	}
}

// isTimeoutError reports an expired request budget. A caller cancellation is not
// a request timeout.
func isTimeoutError(err error) bool {
	var timedOut interface{ Timeout() bool }
	if errors.As(err, &timedOut) {
		return timedOut.Timeout()
	}
	return false
}

// articleSource mirrors `article.domain ?? article.source` followed by the
// string/blank check: a present but blank domain does NOT fall through to
// source, it falls back to the literal "GDELT".
func articleSource(article gdeltArticle) string {
	raw := article.Domain
	if jsonNull(raw) {
		raw = article.Source
	}
	source, _ := jsonString(raw)
	source = strings.TrimSpace(source)
	if source == "" {
		return gdeltFallbackSource
	}
	return source
}

// parseSeenDate converts a GDELT seendate to epoch milliseconds. An unparsable
// value falls back to the current time, matching parseGdeltSeenDate.
func (f *gdeltFetcher) parseSeenDate(raw json.RawMessage) int64 {
	value, ok := jsonString(raw)
	if ok {
		match := seenDatePattern.FindStringSubmatch(strings.TrimSpace(value))
		if match != nil {
			year, _ := strconv.Atoi(match[1])
			month, _ := strconv.Atoi(match[2])
			day, _ := strconv.Atoi(match[3])
			hour, _ := strconv.Atoi(match[4])
			minute, _ := strconv.Atoi(match[5])
			second, _ := strconv.Atoi(match[6])
			// time.Date normalizes out-of-range components the same way
			// Date.UTC does (month 0 becomes December of the previous year).
			return time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC).UnixMilli()
		}
	}
	return f.now().UnixMilli()
}

// jsonNull reports whether a raw JSON member is absent or literally null, which
// is the nullish-coalescing trigger.
func jsonNull(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || string(trimmed) == "null"
}
