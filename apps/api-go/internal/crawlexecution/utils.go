package crawlexecution

import (
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

// normalizedOptions is the fully normalized CrawlTaskOptions document
// (CrawlOptionsNormalizerService.normalizeOptions).
type normalizedOptions = crawloptions.Options

// crawlQueueName is CRAWL_QUEUE_NAME: the task log queue the legacy runTask
// writes under (the item pipeline bridge writes queue=news_pipeline itself).
const crawlQueueName = "crawl4ai"

// stringPtr returns a pointer to value.
func stringPtr(value string) *string { return &value }

// intPtrValue dereferences an optional int for task-log data (nil -> nil so the
// JSON stays null).
func intPtrValue(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

// nullableStringValue returns the pointed-to string or nil.
func nullableStringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

// nullableRunID maps the empty run id to nil (NestJS uses ?? null).
func nullableRunID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// firstStringPtr returns the first non-nil string pointer.
func firstStringPtr(values ...*string) any {
	for _, value := range values {
		if value != nil {
			return *value
		}
	}
	return nil
}

// timePtr returns a pointer to value.
func timePtr(value time.Time) *time.Time { return &value }

// virtualScrollLogValue mirrors the request.virtualScroll block of the crawler
// task log.
func virtualScrollLogValue(value *crawloptions.VirtualScroll) any {
	if value == nil {
		return nil
	}
	scrollBy := any(nil)
	if len(value.ScrollBy) > 0 {
		scrollBy = string(value.ScrollBy)
	}
	container := value.ContainerSelector
	if container == "" {
		container = "body"
	}
	return map[string]any{
		"containerSelector": container,
		"scrollCount":       intPtrValue(value.ScrollCount),
		"scrollBy":          scrollBy,
		"waitAfterScrollMs": intPtrValue(value.WaitAfterScrollMs),
	}
}
