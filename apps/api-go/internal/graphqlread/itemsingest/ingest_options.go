package itemsingestgraphql

import (
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
)

// parseIngestBatchOptions reads the root arguments of
// ingestCrawlTaskResultsToItems. The executor hands over already-coerced GraphQL
// values, so the Go type of an Int argument depends on how the client supplied
// it: an inline literal and a JSON variable arrive as int64 (the request
// decoder keeps json.Number and gqlparser narrows it), while a variable in a GET
// query string arrives as float64. Reading through contract.IntArg covers both
// shapes; a raw float64 type assertion would silently drop the inline-literal
// and JSON-variable cases and fall back to the service default page size. Absent
// and explicit null both leave the option unset, matching NestJS's
// `limit ?? null` pass-through.
func parseIngestBatchOptions(args map[string]any) itemsingest.IngestBatchOptions {
	var options itemsingest.IngestBatchOptions
	if value, state := contract.Lookup(args, "after"); state == contract.ArgValue {
		if text, ok := value.(string); ok {
			options.After = &text
		}
	}
	if number, ok := contract.IntArg(args, "limit"); ok {
		limit := float64(number)
		options.Limit = &limit
	}
	if value, state := contract.Lookup(args, "onlyMissing"); state == contract.ArgValue {
		if flag, ok := value.(bool); ok {
			options.OnlyMissing = &flag
		}
	}
	return options
}
