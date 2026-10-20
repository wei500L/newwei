package crawlmetadata

import (
	"bytes"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
)

// normalizeCrawlOptions ports CrawlMetadataService.normalizeCrawlOptions
// (crawl-metadata.service.ts:1890-1907): coerce to a plain object, run the
// shared proxy guard, normalize through the crawl options normalizer and force
// the two discovery-only flags.
func normalizeCrawlOptions(raw json.RawMessage) (crawl4ai.CrawlOptions, error) {
	trimmed := bytes.TrimSpace(raw)
	object := trimmed
	if len(trimmed) == 0 || trimmed[0] != '{' {
		object = json.RawMessage(`{}`)
	}
	if err := crawlprofile.AssertNoUnsupportedProxy(object, "crawlOptions"); err != nil {
		return crawl4ai.CrawlOptions{}, err
	}
	options := crawl4ai.NormalizeOptions(object)
	options.ExtractLinks = true
	options.Prefetch = true
	return options, nil
}
