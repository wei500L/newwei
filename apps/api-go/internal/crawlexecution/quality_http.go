package crawlexecution

// Publish-signal enrichment for detail-expansion candidates
// (CrawlPublishSignalService.enrichCandidatePublishSignals).
//
// scoreDetailCandidateUrl never reads the live page: it scores the URL shape
// only. Candidate *selection* additionally asks whether a candidate looks like a
// recently published article, which the URL cannot always tell, so the top-K
// candidates are probed once. A probe reads at most the document head: the first
// meta/jsonld publish date wins and the read stops early instead of downloading
// the article. Every probe failure is a soft failure (the candidate keeps its
// URL-path confidence), which is what makes the branch safe to run inline.
//
// The probes run through a fixed-size worker pool like the NestJS Promise.all
// fan-out. The one deliberate difference is the settings source: the Go crawl
// settings reader does not carry the detailPublishSignalHeadFetch* keys yet, so
// the built-in defaults (1500 ms, 2, 8 MB) apply and only the crawl request
// timeout narrows the probe budget.

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"

	"golang.org/x/net/html"
)

// Publish-signal probe defaults (CrawlPublishSignalService).
const (
	defaultPublishSignalHeadFetchTimeoutMs    = 1_500
	defaultPublishSignalHeadFetchConcurrency  = 2
	defaultPublishSignalHeadFetchMaxReadBytes = 8_000_000

	publishSignalHeadProbeBytes = 524_288
	publishSignalMinReadBytes   = 32_768
	publishSignalMaxReadBytes   = 64_000_000
	publishSignalMaxJSONLDNodes = 8

	publishSignalAcceptHeader = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	publishSignalUserAgent    = "Mozilla/5.0 (compatible; CrawlQualityProbe/1.0; +https://example.com)"

	publishSignalConfidenceMeta    = 0.95
	publishSignalConfidenceJSONLD  = 0.92
	publishSignalConfidenceTimeTag = 0.88
)

// publishCandidateSignal is CandidatePublishSignal.
type publishCandidateSignal struct {
	Confidence float64
	Source     string
	Timestamp  *int64
}

// publishSignalSettings is PublishSignalEnrichmentSettings.
type publishSignalSettings struct {
	TimeoutMs    int
	Concurrency  int
	MaxReadBytes int
}

// publishSignalSoftFailures is PublishSignalSoftFailureBreakdown.
type publishSignalSoftFailures struct {
	HTTPStatus       int
	NonHTML          int
	EmptyHTML        int
	NetworkOrTimeout int
	NoPublishSignal  int
}

// count is countPublishSignalSoftFailures.
func (b publishSignalSoftFailures) count() int {
	return b.HTTPStatus + b.NonHTML + b.EmptyHTML + b.NetworkOrTimeout + b.NoPublishSignal
}

// increment is incrementPublishSignalSoftFailure.
func (b *publishSignalSoftFailures) increment(reason string) {
	switch reason {
	case "http_status":
		b.HTTPStatus++
	case "non_html":
		b.NonHTML++
	case "empty_html":
		b.EmptyHTML++
	case "network_or_timeout":
		b.NetworkOrTimeout++
	default:
		b.NoPublishSignal++
	}
}

// publishSignalEnrichment is PublishSignalEnrichmentResult.
type publishSignalEnrichment struct {
	Signals               map[string]publishCandidateSignal
	Attempted             int
	Succeeded             int
	Failed                int
	Skipped               bool
	EffectiveTimeoutMs    int
	EffectiveConcurrency  int
	MaxReadBytes          int
	TruncatedResponses    int
	EarlyStoppedResponses int
	SoftFailures          publishSignalSoftFailures
}

// softFailureCount is countPublishSignalSoftFailures over the breakdown.
func (e publishSignalEnrichment) softFailureCount() int { return e.SoftFailures.count() }

// resolvePublishSignalTopK is resolvePublishSignalTopK: probe at least three and
// at most eighteen of the strongest candidates, never more than the pool.
func resolvePublishSignalTopK(candidateLimit, maxDetailURLs, candidatePoolSize int) int {
	if candidatePoolSize <= 0 {
		return 0
	}
	desired := maxIntValue(3, minIntValue(18, maxIntValue(candidateLimit+2, maxDetailURLs)))
	return maxIntValue(0, minIntValue(candidatePoolSize, desired))
}

// defaultPublishSignalSettings is the built-in enrichment settings.
func defaultPublishSignalSettings() publishSignalSettings {
	return publishSignalSettings{
		TimeoutMs:    defaultPublishSignalHeadFetchTimeoutMs,
		Concurrency:  defaultPublishSignalHeadFetchConcurrency,
		MaxReadBytes: defaultPublishSignalHeadFetchMaxReadBytes,
	}
}

// publishSignalEnrichmentSettings resolves the enrichment settings. The Go crawl
// settings reader has no detailPublishSignalHeadFetch* keys, so the caller keeps
// the defaults and only the request timeout narrows the probe budget.
func (s *Service) publishSignalEnrichmentSettings() publishSignalSettings {
	return defaultPublishSignalSettings()
}

// resolvePublishSignalFetchTimeoutMs is resolvePublishSignalFetchTimeoutMs.
func resolvePublishSignalFetchTimeoutMs(configuredTimeoutMs, requestTimeoutMs int) int {
	fromSettings := defaultPublishSignalHeadFetchTimeoutMs
	if configuredTimeoutMs > 0 {
		fromSettings = clampInt(jsRoundInt(configuredTimeoutMs), 500, 10_000)
	}
	if requestTimeoutMs > 0 {
		requestBound := clampInt(jsRoundInt(requestTimeoutMs), 500, 10_000)
		return minIntValue(fromSettings, requestBound)
	}
	return fromSettings
}

// resolvePublishSignalFetchConcurrency is resolvePublishSignalFetchConcurrency.
func resolvePublishSignalFetchConcurrency(configuredConcurrency int) int {
	if configuredConcurrency <= 0 {
		return defaultPublishSignalHeadFetchConcurrency
	}
	return clampInt(jsRoundInt(configuredConcurrency), 1, 8)
}

// resolvePublishSignalMaxReadBytes is resolvePublishSignalMaxReadBytes.
func resolvePublishSignalMaxReadBytes(configuredMaxReadBytes int) int {
	if configuredMaxReadBytes <= 0 {
		return defaultPublishSignalHeadFetchMaxReadBytes
	}
	return clampInt(jsRoundInt(configuredMaxReadBytes), 1_048_576, 64_000_000)
}

// clampInt bounds an int.
func clampInt(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

// jsRoundInt is Math.round for an int input.
func jsRoundInt(value int) int { return int(jsRound(float64(value))) }

// enrichCandidatePublishSignals is enrichCandidatePublishSignals. It probes each
// unique candidate once; a probe that yields no publish signal is a soft failure
// and the candidate keeps its URL-path confidence.
func (s *Service) enrichCandidatePublishSignals(
	ctx context.Context,
	urls []string,
	requestTimeoutMs int,
	settings publishSignalSettings,
) publishSignalEnrichment {
	timeoutMs := resolvePublishSignalFetchTimeoutMs(settings.TimeoutMs, requestTimeoutMs)
	maxReadBytes := resolvePublishSignalMaxReadBytes(settings.MaxReadBytes)
	unique := make([]string, 0, len(urls))
	seen := make(map[string]struct{}, len(urls))
	for _, raw := range urls {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		unique = append(unique, trimmed)
	}
	result := publishSignalEnrichment{
		Signals:              make(map[string]publishCandidateSignal, len(unique)),
		EffectiveTimeoutMs:   timeoutMs,
		EffectiveConcurrency: resolvePublishSignalFetchConcurrency(settings.Concurrency),
		MaxReadBytes:         maxReadBytes,
	}
	if len(unique) == 0 {
		return result
	}
	result.EffectiveConcurrency = maxIntValue(1, minIntValue(len(unique), result.EffectiveConcurrency))
	result.Attempted = len(unique)

	// The probes run through a fixed-size worker pool, like the NestJS
	// Promise.all fan-out: one slow host cannot serialize every candidate.
	type probeOutcome struct {
		Signal        publishCandidateSignal
		OK            bool
		Truncated     bool
		EarlyStopped  bool
		FailureReason string
		Attempted     bool
	}
	outcomes := make([]probeOutcome, len(unique))
	var cursorMutex sync.Mutex
	cursor := 0
	var workers sync.WaitGroup
	for workerIndex := 0; workerIndex < result.EffectiveConcurrency; workerIndex++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				cursorMutex.Lock()
				index := cursor
				cursor++
				cursorMutex.Unlock()
				if index >= len(unique) {
					return
				}
				if ctx != nil && ctx.Err() != nil {
					return
				}
				signal, ok, truncated, earlyStopped, failureReason := s.fetchCandidatePublishSignal(ctx, unique[index], timeoutMs, maxReadBytes)
				outcomes[index] = probeOutcome{
					Signal:        signal,
					OK:            ok,
					Truncated:     truncated,
					EarlyStopped:  earlyStopped,
					FailureReason: failureReason,
					Attempted:     true,
				}
			}
		}()
	}
	workers.Wait()
	for index, outcome := range outcomes {
		if !outcome.Attempted {
			continue
		}
		if outcome.Truncated {
			result.TruncatedResponses++
		}
		if outcome.EarlyStopped {
			result.EarlyStoppedResponses++
		}
		if outcome.OK && outcome.Signal.Source != publishTimeSourceNone {
			result.Signals[unique[index]] = outcome.Signal
			result.Succeeded++
			continue
		}
		result.SoftFailures.increment(outcome.FailureReason)
		result.Failed++
	}
	return result
}

// fetchCandidatePublishSignal is fetchCandidatePublishSignal: GET with the
// quality-probe headers, then read only as much of the document as the head
// signal needs. Every failure reason is a soft failure.
func (s *Service) fetchCandidatePublishSignal(
	ctx context.Context,
	targetURL string,
	timeoutMs, maxReadBytes int,
) (signal publishCandidateSignal, ok, truncated, earlyStopped bool, failureReason string) {
	headers := map[string]string{
		"accept":     publishSignalAcceptHeader,
		"user-agent": publishSignalUserAgent,
	}
	var response *http.Response
	var fetched bool
	if s.publishSignalFetch != nil {
		response, fetched = s.publishSignalFetch(ctx, targetURL, timeoutMs)
	} else {
		response, _, fetched = s.ssrfSafeFetch(ctx, targetURL, http.MethodGet, headers, timeoutMs)
	}
	if !fetched || response == nil {
		return publishCandidateSignal{}, false, false, false, "network_or_timeout"
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return publishCandidateSignal{}, false, false, false, "http_status"
	}
	contentType := strings.ToLower(response.Header.Get("content-type"))
	if contentType != "" &&
		!strings.Contains(contentType, "text/html") &&
		!strings.Contains(contentType, "application/xhtml+xml") {
		return publishCandidateSignal{}, false, false, false, "non_html"
	}
	document, truncated, earlyStopped := readPublishSignalHTML(response.Body, maxReadBytes)
	if strings.TrimSpace(document) == "" {
		return publishCandidateSignal{}, false, truncated, earlyStopped, "empty_html"
	}
	extracted, found := extractPublishSignalFromHTML(document, true)
	if !found {
		return publishCandidateSignal{}, false, truncated, earlyStopped, "no_publish_signal"
	}
	return extracted, true, truncated, earlyStopped, ""
}

// readPublishSignalHTML is readPublishSignalHtmlWithSoftLimit: read up to the
// byte ceiling, but stop as soon as the closed head carries a meta or JSON-LD
// publish date.
func readPublishSignalHTML(body io.Reader, maxBytes int) (document string, truncated, earlyStopped bool) {
	if body == nil {
		return "", false, false
	}
	limit := maxBytes
	if limit <= 0 {
		limit = defaultPublishSignalHeadFetchMaxReadBytes
	}
	limit = clampInt(limit, publishSignalMinReadBytes, publishSignalMaxReadBytes)
	headProbeBytes := minIntValue(limit, publishSignalHeadProbeBytes)
	builder := strings.Builder{}
	buffer := make([]byte, 32*1024)
	bytesRead := 0
	probePending := true
	for {
		read, err := body.Read(buffer)
		if read > 0 {
			remaining := limit - bytesRead
			if remaining <= 0 {
				truncated = true
				break
			}
			chunk := buffer[:read]
			if read > remaining {
				chunk = chunk[:remaining]
				truncated = true
			}
			builder.Write(chunk)
			bytesRead += len(chunk)
			if probePending {
				current := builder.String()
				if strings.Contains(current, "</head>") || bytesRead >= headProbeBytes {
					probePending = false
					if probe, found := extractPublishSignalFromHTML(current, false); found &&
						(probe.Source == publishTimeSourceMeta || probe.Source == publishTimeSourceJSONLD) {
						earlyStopped = true
						break
					}
				}
			}
			if truncated {
				break
			}
		}
		if err != nil {
			// io.EOF ends the document; any other read error keeps what was read
			// so far and degrades to a soft failure like a truncated response.
			break
		}
		if read == 0 {
			break
		}
	}
	return builder.String(), truncated, earlyStopped
}

// extractPublishSignalFromHTML is extractPublishSignalFromHtml: the six meta
// selectors in order, then the head JSON-LD scripts, then the first
// time[datetime] of the document.
func extractPublishSignalFromHTML(document string, includeTimeTag bool) (publishCandidateSignal, bool) {
	root, err := html.Parse(strings.NewReader(document))
	if err != nil || root == nil {
		return publishCandidateSignal{}, false
	}
	head := findFirstElement(root, "head")
	if head != nil {
		metaSelectors := []struct {
			Attribute string
			Value     string
		}{
			{"property", "article:published_time"},
			{"property", "og:published_time"},
			{"name", "pubdate"},
			{"name", "publishdate"},
			{"name", "date"},
			{"itemprop", "datePublished"},
		}
		for _, selector := range metaSelectors {
			meta := findMetaElement(head, selector.Attribute, selector.Value)
			if meta == nil {
				continue
			}
			timestamp, ok := parseJSDateMilliseconds(strings.TrimSpace(attributeValue(meta, "content")))
			if !ok {
				continue
			}
			value := timestamp
			return publishCandidateSignal{Confidence: publishSignalConfidenceMeta, Source: publishTimeSourceMeta, Timestamp: &value}, true
		}
		scripts := findJSONLDScripts(head)
		for index, script := range scripts {
			if index >= publishSignalMaxJSONLDNodes {
				break
			}
			raw := strings.TrimSpace(textContent(script))
			if raw == "" {
				continue
			}
			timestamp, ok := findJSONLDPublishTimestamp(json.RawMessage(raw))
			if !ok {
				continue
			}
			value := timestamp
			return publishCandidateSignal{Confidence: publishSignalConfidenceJSONLD, Source: publishTimeSourceJSONLD, Timestamp: &value}, true
		}
	}
	if includeTimeTag {
		if timeNode := findFirstElementWithAttribute(root, "time", "datetime"); timeNode != nil {
			timestamp, ok := parseJSDateMilliseconds(strings.TrimSpace(attributeValue(timeNode, "datetime")))
			if ok {
				value := timestamp
				return publishCandidateSignal{Confidence: publishSignalConfidenceTimeTag, Source: publishTimeSourceTimeTag, Timestamp: &value}, true
			}
		}
	}
	return publishCandidateSignal{}, false
}

// findJSONLDPublishTimestamp is findJsonLdPublishTimestamp: datePublished, then
// dateCreated, then dateModified, then a depth-first walk of every member.
func findJSONLDPublishTimestamp(raw json.RawMessage) (int64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	if trimmed[0] == '[' {
		var entries []json.RawMessage
		if err := json.Unmarshal([]byte(trimmed), &entries); err != nil {
			return 0, false
		}
		for _, entry := range entries {
			if timestamp, ok := findJSONLDPublishTimestamp(entry); ok {
				return timestamp, true
			}
		}
		return 0, false
	}
	if trimmed[0] != '{' {
		return 0, false
	}
	object := decodeOrderedObject(json.RawMessage(trimmed))
	if object == nil {
		return 0, false
	}
	for _, key := range []string{"datePublished", "dateCreated", "dateModified"} {
		value, ok := object.lookup(key)
		if !ok {
			continue
		}
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			continue
		}
		if timestamp, ok := parseJSDateMilliseconds(strings.TrimSpace(text)); ok {
			return timestamp, true
		}
	}
	for _, value := range object.Values {
		if timestamp, ok := findJSONLDPublishTimestamp(value); ok {
			return timestamp, true
		}
	}
	return 0, false
}

// resolveCandidatePublishSignal is resolveCandidatePublishSignal: the enriched
// signal wins only when it is at least as confident as the URL-path signal.
func resolveCandidatePublishSignal(candidateURL string, enriched *publishCandidateSignal) publishCandidateSignal {
	pathSignal := publishCandidateSignal{
		Confidence: estimatePublishTimeConfidenceFromCandidateURL(candidateURL),
		Source:     publishTimeSourceURLPath,
	}
	if timestamp, ok := parseDateFromArticleURL(candidateURL); ok {
		value := timestamp
		pathSignal.Timestamp = &value
	}
	if enriched == nil {
		return pathSignal
	}
	if enriched.Confidence >= pathSignal.Confidence {
		return *enriched
	}
	return pathSignal
}

// detailCandidateConfidenceBuckets is DetailCandidateConfidenceBuckets.
type detailCandidateConfidenceBuckets struct {
	LT04       int
	From04To06 int
	From06To08 int
	GTE08      int
}

// buildDetailCandidateConfidenceBuckets is buildDetailCandidateConfidenceBuckets.
func buildDetailCandidateConfidenceBuckets(signals map[string]publishCandidateSignal, candidateURLs []string) detailCandidateConfidenceBuckets {
	buckets := detailCandidateConfidenceBuckets{}
	for _, candidateURL := range candidateURLs {
		confidence := estimatePublishTimeConfidenceFromCandidateURL(candidateURL)
		if signal, ok := signals[candidateURL]; ok {
			confidence = signal.Confidence
		}
		if math.IsNaN(confidence) || math.IsInf(confidence, 0) {
			continue
		}
		switch {
		case confidence < 0.4:
			buckets.LT04++
		case confidence < 0.6:
			buckets.From04To06++
		case confidence < 0.8:
			buckets.From06To08++
		default:
			buckets.GTE08++
		}
	}
	return buckets
}

// --- golang.org/x/net/html helpers ---

// findFirstElement returns the first element with the given tag in document
// order.
func findFirstElement(node *html.Node, tag string) *html.Node {
	if node == nil {
		return nil
	}
	if node.Type == html.ElementNode && node.Data == tag {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := findFirstElement(child, tag); found != nil {
			return found
		}
	}
	return nil
}

// findFirstElementWithAttribute returns the first element with the given tag and
// a non-empty attribute in document order.
func findFirstElementWithAttribute(node *html.Node, tag, attribute string) *html.Node {
	if node == nil {
		return nil
	}
	if node.Type == html.ElementNode && node.Data == tag && attributeValue(node, attribute) != "" {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := findFirstElementWithAttribute(child, tag, attribute); found != nil {
			return found
		}
	}
	return nil
}

// attributeValue returns one attribute value or "".
func attributeValue(node *html.Node, name string) string {
	if node == nil {
		return ""
	}
	for _, attribute := range node.Attr {
		if attribute.Key == name {
			return attribute.Val
		}
	}
	return ""
}

// findMetaElement returns the first meta element with the given attribute value.
func findMetaElement(root *html.Node, attribute, value string) *html.Node {
	if root == nil {
		return nil
	}
	if root.Type == html.ElementNode && root.Data == "meta" &&
		strings.EqualFold(attributeValue(root, attribute), value) {
		return root
	}
	for child := root.FirstChild; child != nil; child = child.NextSibling {
		if found := findMetaElement(child, attribute, value); found != nil {
			return found
		}
	}
	return nil
}

// findJSONLDScripts collects the head script[type=application/ld+json] elements
// in document order.
func findJSONLDScripts(head *html.Node) []*html.Node {
	scripts := make([]*html.Node, 0, 4)
	var walk func(node *html.Node)
	walk = func(node *html.Node) {
		if node == nil {
			return
		}
		if node.Type == html.ElementNode && node.Data == "script" &&
			strings.EqualFold(strings.TrimSpace(attributeValue(node, "type")), "application/ld+json") {
			scripts = append(scripts, node)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(head)
	return scripts
}

// textContent is cheerio's .text(): the concatenated text descendants.
func textContent(node *html.Node) string {
	if node == nil {
		return ""
	}
	builder := strings.Builder{}
	var walk func(current *html.Node)
	walk = func(current *html.Node) {
		if current == nil {
			return
		}
		if current.Type == html.TextNode {
			builder.WriteString(current.Data)
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return builder.String()
}
