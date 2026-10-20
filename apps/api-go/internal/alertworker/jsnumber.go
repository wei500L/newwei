package alertworker

import "github.com/wei500L/newwei/apps/api-go/internal/alertworker/jsnum"

// This file re-exports the JavaScript number formatting helpers under the names
// the alert worker call sites use. It is intentionally thin: jsnum owns the
// ECMAScript-compatible algorithms.

// FormatJSNumber is jsnum.Format.
func FormatJSNumber(value float64) string {
	return jsnum.Format(value)
}

// FormatJSFixed is jsnum.ToFixed.
func FormatJSFixed(value float64, digits int) string {
	return jsnum.ToFixed(value, digits)
}
