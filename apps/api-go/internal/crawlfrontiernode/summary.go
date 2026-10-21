package crawlfrontiernode

// summary.go is the returned CrawlExecutionSummary.
//
// NestJS returns the object literally constructed by
// CrawlResultService.persistResults:
//
//	return {
//	  inserted,
//	  skipped,
//	  ...(reusedResultId ? { reusedResultId } : {}),
//	  ...(ingestToItems ? { itemsQueued, itemsQueueFailed } : {}),
//	  lastFetchedAt: latestResultAt ?? reusedResultFetchedAt,
//	  runId,
//	  memory,
//	};
//
// The Frontier call site passes no ingestToItems and no memory argument, so the
// two spreads evaluate to undefined and JSON.stringify drops them. The key order
// is therefore fixed: inserted, skipped, reusedResultId?, lastFetchedAt?, runId?
// (`lastFetchedAt: undefined` and `runId: undefined` are present in the object
// but omitted from the serialized JSON).
//
// The two short-circuit returns in processQueuedNode build their own object
// literal `{ inserted: 0, skipped: 0 }`, which is the zero value below.

import (
	"bytes"
	"encoding/json"
	"strconv"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// CrawlExecutionSummary is the value processQueuedNode resolves with.
type CrawlExecutionSummary struct {
	Inserted       int
	Skipped        int
	ReusedResultID string
	LastFetchedAt  *time.Time
	RunID          string
}

// emptySummary is the `{ inserted: 0, skipped: 0 }` literal.
func emptySummary() CrawlExecutionSummary { return CrawlExecutionSummary{} }

// MarshalJSON writes the keys in the NestJS construction order and omits the
// undefined ones. It never goes through a map, so the byte order is stable.
func (summary CrawlExecutionSummary) MarshalJSON() ([]byte, error) {
	buffer := &bytes.Buffer{}
	buffer.WriteString(`{"inserted":`)
	buffer.WriteString(strconv.Itoa(summary.Inserted))
	buffer.WriteString(`,"skipped":`)
	buffer.WriteString(strconv.Itoa(summary.Skipped))
	if summary.ReusedResultID != "" {
		encoded, err := json.Marshal(summary.ReusedResultID)
		if err != nil {
			return nil, err
		}
		buffer.WriteString(`,"reusedResultId":`)
		buffer.Write(encoded)
	}
	if summary.LastFetchedAt != nil {
		encoded, err := json.Marshal(crawlfrontierllm.NestISOString(*summary.LastFetchedAt))
		if err != nil {
			return nil, err
		}
		buffer.WriteString(`,"lastFetchedAt":`)
		buffer.Write(encoded)
	}
	if summary.RunID != "" {
		encoded, err := json.Marshal(summary.RunID)
		if err != nil {
			return nil, err
		}
		buffer.WriteString(`,"runId":`)
		buffer.Write(encoded)
	}
	buffer.WriteString("}")
	return buffer.Bytes(), nil
}

// marshalSummary serializes a summary for the interface contract.
func marshalSummary(summary CrawlExecutionSummary) (json.RawMessage, error) {
	if summary.LastFetchedAt != nil {
		// MySQL DATETIME(3) values are already millisecond precise; formatting
		// through NestISOString keeps the UTC 3-digit Z form either way.
		value := summary.LastFetchedAt.UTC()
		summary.LastFetchedAt = &value
	}
	return json.Marshal(summary)
}
