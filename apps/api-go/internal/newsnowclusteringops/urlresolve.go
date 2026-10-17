package newsnowclusteringops

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// resolveCacheKeyPrefix is the Redis key prefix for the URL reverse-lookup
// cache. NestJS keys the same cache as
// "news-aggregator:resolve:v1:<sha1(full|base)>"; the Go takeover keys it by
// the comparable full-URL hash instead, so the two caches coexist without
// interfering while the traffic is being flipped.
const resolveCacheKeyPrefix = "newsnow:resolve:v1"

const (
	// resolveMatchTTLSeconds caches a positive match for five minutes.
	resolveMatchTTLSeconds = 300
	// resolveMissTTLSeconds caches a negative result for thirty seconds so that
	// a just-crawled item becomes visible quickly.
	resolveMissTTLSeconds = 30
	// resolveProcessedItemLimit caps the ProcessedItem rows inspected per hit.
	resolveProcessedItemLimit = 20
)

// comparableURLVariants is the triple produced by buildComparableUrlVariants in
// packages/mongo/src/url-comparison.ts.
type comparableURLVariants struct {
	Full     string
	Base     string
	FullHash string
}

// resolveRawRow is the projection of a Mongo rawitems document the resolver
// needs. It mirrors the NestJS projection
// { itemMetaId: 1, "payload.url": 1, createdAt: 1 }.
type resolveRawRow struct {
	ItemMetaID string
	PayloadURL string
	CreatedAt  time.Time
}

// resolveStore is the data access the URL resolver needs. Splitting it out
// keeps the five-level match order testable without Mongo.
type resolveStore interface {
	// FindRawItemByFullHashAndFull performs match level 1.
	FindRawItemByFullHashAndFull(ctx context.Context, fullHash, full string) (*resolveRawRow, error)
	// FindRawItemByFull performs match level 2.
	FindRawItemByFull(ctx context.Context, full string) (*resolveRawRow, error)
	// FindRawItemByPayloadURL performs match level 3 for one or more exact
	// payload.url values.
	FindRawItemByPayloadURL(ctx context.Context, candidates []string) (*resolveRawRow, error)
	// FindRawItemByBase performs match level 4.
	FindRawItemByBase(ctx context.Context, base string) (*resolveRawRow, error)
	// FindRawItemByPayloadURLPattern performs match level 5.
	FindRawItemByPayloadURLPattern(ctx context.Context, pattern string) (*resolveRawRow, error)
	// FindItemMetaOrgID resolves the owning organization of an ItemMeta row.
	// The second result is false when the row no longer exists.
	FindItemMetaOrgID(ctx context.Context, itemMetaID string) (string, bool, error)
	// FindCompletedProcessedItemIDs returns the newest completed ProcessedItem
	// ids of one organization that reference itemMetaID.
	FindCompletedProcessedItemIDs(ctx context.Context, orgID, itemMetaID string) ([]string, error)
	// FindLatestEventID returns the newest NewsEventItem.eventId of one
	// organization linked to any of processedItemIDs.
	FindLatestEventID(ctx context.Context, orgID string, processedItemIDs []string) (string, error)
}

// resolveCache is the Redis subset the resolver uses.
type resolveCache interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, value []byte, ttlSeconds int) error
}

// resolveResponseJSON renders a response for the cache. Cache reads reuse the
// exact bytes NestJS would have stored so that a warm cache yields a
// byte-identical body.
type urlResolver struct {
	store resolveStore
	cache resolveCache
}

// newURLResolver builds a resolver over the given store and cache.
func newURLResolver(store resolveStore, cache resolveCache) *urlResolver {
	return &urlResolver{store: store, cache: cache}
}

// resolveByURL mirrors NewsAggregatorService.resolveByUrl plus
// resolveByUrlUncached. The caller has already validated and normalized the URL
// through validateHTTPURL.
func (r *urlResolver) resolveByURL(ctx context.Context, normalizedURL string) (ResolveResponse, error) {
	rawURL := strings.TrimSpace(normalizedURL)
	comparable, ok := buildComparableURLVariants(rawURL)
	if !ok {
		return ResolveResponse{Matched: false}, nil
	}

	cacheKey := resolveCacheKeyPrefix + ":" + comparable.FullHash
	if r.cache != nil {
		if cached, hit, err := r.cache.Get(ctx, cacheKey); err == nil && hit {
			if decoded, ok := decodeResolveResponse(cached); ok {
				return decoded, nil
			}
		}
	}

	resolved, err := r.resolveUncached(ctx, rawURL, comparable)
	if err != nil {
		return ResolveResponse{}, err
	}
	if r.cache != nil {
		ttl := resolveMissTTLSeconds
		if resolved.Matched {
			ttl = resolveMatchTTLSeconds
		}
		if encoded, err := encodeResolveResponse(resolved); err == nil {
			// Best effort: a cache failure must never fail the request.
			_ = r.cache.Set(ctx, cacheKey, encoded, ttl)
		}
	}
	return resolved, nil
}

// resolveUncached performs the five-level priority match, then binds the
// ProcessedItem and NewsEventItem lookups to the owning organization of the
// matched ItemMeta.
func (r *urlResolver) resolveUncached(ctx context.Context, rawURL string, comparable comparableURLVariants) (ResolveResponse, error) {
	// Level 1: comparable full URL plus its hash.
	fullHashMatch, err := r.store.FindRawItemByFullHashAndFull(ctx, comparable.FullHash, comparable.Full)
	if err != nil {
		return ResolveResponse{}, err
	}
	// Level 2: comparable full URL only, for rows written before the hash
	// column was backfilled.
	var legacyFullMatch *resolveRawRow
	if fullHashMatch == nil {
		legacyFullMatch, err = r.store.FindRawItemByFull(ctx, comparable.Full)
		if err != nil {
			return ResolveResponse{}, err
		}
	}
	// Level 3: the legacy exact payload.url match. rawURL is the
	// controller-normalized URL, so both spellings are tried. Keeping this
	// ahead of the base match preserves the pre-comparable-column behaviour.
	var payloadMatch *resolveRawRow
	if fullHashMatch == nil && legacyFullMatch == nil {
		candidates := uniqueNonEmpty(rawURL, comparable.Full)
		if len(candidates) > 0 {
			payloadMatch, err = r.store.FindRawItemByPayloadURL(ctx, candidates)
			if err != nil {
				return ResolveResponse{}, err
			}
		}
	}
	// Level 4: comparable base URL with the query string dropped.
	var baseMatch *resolveRawRow
	if fullHashMatch == nil && legacyFullMatch == nil && payloadMatch == nil {
		baseMatch, err = r.store.FindRawItemByBase(ctx, comparable.Base)
		if err != nil {
			return ResolveResponse{}, err
		}
	}
	// Level 5: case-insensitive prefix regex over payload.url.
	var patternMatch *resolveRawRow
	if fullHashMatch == nil && legacyFullMatch == nil && payloadMatch == nil && baseMatch == nil {
		pattern := "^" + escapeRegex(comparable.Base) + "(?:/)?(?:[?#].*)?$"
		patternMatch, err = r.store.FindRawItemByPayloadURLPattern(ctx, pattern)
		if err != nil {
			return ResolveResponse{}, err
		}
	}

	resolvedRaw := firstNonNil(fullHashMatch, legacyFullMatch, payloadMatch, baseMatch, patternMatch)
	if resolvedRaw == nil {
		return ResolveResponse{Matched: false}, nil
	}
	itemMetaID := strings.TrimSpace(resolvedRaw.ItemMetaID)
	if itemMetaID == "" {
		return ResolveResponse{Matched: false}, nil
	}

	// Bug fix (shared with NestJS): an ItemMeta that no longer exists must not
	// keep serving other tenants' data, and every downstream lookup is scoped to
	// the organization that actually owns the ItemMeta.
	orgID, found, err := r.store.FindItemMetaOrgID(ctx, itemMetaID)
	if err != nil {
		return ResolveResponse{}, err
	}
	if !found || strings.TrimSpace(orgID) == "" {
		return ResolveResponse{Matched: false}, nil
	}

	processedItemIDs, err := r.store.FindCompletedProcessedItemIDs(ctx, orgID, itemMetaID)
	if err != nil {
		return ResolveResponse{}, err
	}
	eventID := ""
	if len(processedItemIDs) > 0 {
		eventID, err = r.store.FindLatestEventID(ctx, orgID, processedItemIDs)
		if err != nil {
			return ResolveResponse{}, err
		}
	}

	confidence := 0.86
	switch {
	case fullHashMatch != nil || legacyFullMatch != nil || payloadMatch != nil:
		confidence = 1
	case baseMatch != nil:
		confidence = 0.93
	}

	response := ResolveResponse{Matched: true, ItemID: itemMetaID}
	if eventID != "" {
		response.EventID = eventID
	}
	response.Confidence = &confidence
	if resolvedRaw.PayloadURL != "" {
		response.MatchedURL = resolvedRaw.PayloadURL
	}
	return response, nil
}

// buildComparableURLVariants mirrors buildComparableUrlVariants in
// packages/mongo/src/url-comparison.ts.
func buildComparableURLVariants(value string) (comparableURLVariants, bool) {
	parsed, ok := parseJSURL(value)
	if !ok {
		return comparableURLVariants{}, false
	}
	canonical := parsed.String()
	full, ok := normalizeComparableHTTPURL(canonical, true)
	if !ok {
		return comparableURLVariants{}, false
	}
	base, ok := normalizeComparableHTTPURL(canonical, false)
	if !ok {
		return comparableURLVariants{}, false
	}
	sum := sha256.Sum256([]byte(full))
	return comparableURLVariants{Full: full, Base: base, FullHash: hex.EncodeToString(sum[:])}, true
}

// hashComparableURL mirrors hashComparableUrl.
func hashComparableURL(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// normalizeComparableHTTPURL mirrors normalizeComparableHttpUrl: it drops the
// fragment, lowercases the host, optionally drops the query string, strips
// trailing slashes from a non-root path, and finally strips the trailing slash
// of a bare root URL.
func normalizeComparableHTTPURL(canonical string, keepSearch bool) (string, bool) {
	parsed, ok := parseJSURL(canonical)
	if !ok {
		return "", false
	}
	parsed.Fragment = ""
	parsed.HasFragment = false
	parsed.Host = strings.ToLower(parsed.Host)
	if !keepSearch {
		parsed.Query = ""
		parsed.HasQuery = false
	}
	if parsed.Path != "/" {
		parsed.Path = strings.TrimRight(parsed.Path, "/")
		// Assigning an empty pathname to a WHATWG URL reads back as "/".
		if parsed.Path == "" {
			parsed.Path = "/"
		}
	}
	normalized := parsed.String()
	if strings.HasSuffix(normalized, "/") && parsed.Path == "/" {
		normalized = normalized[:len(normalized)-1]
	}
	return normalized, true
}

// jsURL is the subset of a WHATWG URL record this package needs. It exists
// because Go's net/url preserves host case and keeps a trailing "/" on a root
// path, both of which would change the comparable variants.
type jsURL struct {
	Scheme      string
	UserInfo    string
	Host        string
	Port        string
	Path        string
	Query       string
	HasQuery    bool
	Fragment    string
	HasFragment bool
}

// String serializes the record the way WHATWG URL.prototype.toString does for
// the special http and https schemes.
func (u jsURL) String() string {
	var b strings.Builder
	b.WriteString(u.Scheme)
	b.WriteString("://")
	if u.UserInfo != "" {
		b.WriteString(u.UserInfo)
		b.WriteByte('@')
	}
	b.WriteString(u.Host)
	if u.Port != "" {
		b.WriteByte(':')
		b.WriteString(u.Port)
	}
	if u.Path == "" {
		b.WriteByte('/')
	} else {
		b.WriteString(u.Path)
	}
	if u.HasQuery || u.Query != "" {
		b.WriteByte('?')
		b.WriteString(u.Query)
	}
	if u.HasFragment || u.Fragment != "" {
		b.WriteByte('#')
		b.WriteString(u.Fragment)
	}
	return b.String()
}

// parseJSURL parses an absolute http/https URL and canonicalizes it the way
// WHATWG URL does: lowercased scheme and host, default port removed, empty path
// treated as "/".
func parseJSURL(raw string) (jsURL, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return jsURL{}, false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return jsURL{}, false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return jsURL{}, false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return jsURL{}, false
	}
	port := parsed.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	userInfo := ""
	if parsed.User != nil {
		userInfo = parsed.User.Username()
		if password, ok := parsed.User.Password(); ok {
			userInfo += ":" + password
		}
	}
	path := parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	return jsURL{
		Scheme:      scheme,
		UserInfo:    userInfo,
		Host:        host,
		Port:        port,
		Path:        path,
		Query:       parsed.RawQuery,
		HasQuery:    parsed.ForceQuery,
		Fragment:    parsed.EscapedFragment(),
		HasFragment: parsed.Fragment != "",
	}, true
}

// escapeRegex mirrors the NestJS escapeRegex helper so the fifth match level
// builds the same Mongo regular expression.
func escapeRegex(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch r {
		case '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '[', ']', '|', '\\':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// uniqueNonEmpty returns the distinct non-empty values in argument order.
func uniqueNonEmpty(values ...string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

// firstNonNil returns the first non-nil row of the priority chain.
func firstNonNil(rows ...*resolveRawRow) *resolveRawRow {
	for _, row := range rows {
		if row != nil {
			return row
		}
	}
	return nil
}

// errResolveCacheDecode reports a cache entry that is not a valid resolve
// response.
var errResolveCacheDecode = errors.New("newsnowclusteringops: invalid cached resolve response")

// encodeResolveResponse serializes a resolve response for the Redis cache.
func encodeResolveResponse(value ResolveResponse) ([]byte, error) {
	return json.Marshal(value)
}

// decodeResolveResponse parses a cached resolve response. A corrupted entry is
// treated as a miss so the request falls through to the database.
func decodeResolveResponse(raw []byte) (ResolveResponse, bool) {
	var out ResolveResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return ResolveResponse{}, false
	}
	return out, true
}

// resolveCacheKeyToken returns the sha1 token NestJS derives from the full and
// base variants. It is kept for diagnostics and for parity tests.
func resolveCacheKeyToken(comparable comparableURLVariants) string {
	sum := sha1.Sum([]byte(comparable.Full + "|" + comparable.Base))
	return hex.EncodeToString(sum[:])
}

// regexCachePattern is the compiled form of the fifth-level Mongo pattern. It
// is exported through the store interface as a string, so this helper exists
// only for tests.
func regexCachePattern(base string) *regexp.Regexp {
	return regexp.MustCompile("(?i)^" + escapeRegex(base) + "(?:/)?(?:[?#].*)?$")
}
