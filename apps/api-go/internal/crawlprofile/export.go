package crawlprofile

import "encoding/json"

// NormalizeConfigJSON returns the JSON encoding of normalizeCrawlSiteProfileConfig(raw),
// so callers in other packages never see the internal untyped map.
//
// It is the single exported entry point to the profile configuration
// normalization that already backs the crawl-profile HTTP routes. Callers that
// only need the normalized JSON document (for example the crawl frontier run
// detail response) must use this function instead of re-implementing the
// normalization rules.
func NormalizeConfigJSON(raw json.RawMessage) (json.RawMessage, error) {
	normalized, err := normalizeCrawlSiteProfileConfig(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(normalized)
}
