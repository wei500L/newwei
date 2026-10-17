package itemsreading

import "time"

// This file re-exports the small set of helpers the GraphQL adapter package
// needs. They stay defined once in the domain package so the adapter cannot
// diverge from the REST paths.

// ParseTimeValue parses a DateTime string using the same layouts the REST and
// filter paths accept.
func ParseTimeValue(value string) (time.Time, bool) {
	return parseTimeValue(value)
}

// ResolvePublishedFromResult ports resolvePublishedAtFromProcessedResult.
func ResolvePublishedFromResult(result OpenJSON) *string {
	return resolvePublishedAtFromProcessedResult(result)
}

// ResolvePublishedFromPayload ports resolvePublishedAtFromRawPayload.
func ResolvePublishedFromPayload(payload OpenJSON) *string {
	return resolvePublishedAtFromRawPayload(payload)
}
