package analysisexport

import (
	"io"
	"regexp"
	"strconv"
	"strings"
)

// The two CSV headers are the exact column order of buildItemsExportRows /
// buildEventsExportRows in analysis-workspace.service.ts.
var (
	itemsHeader = []string{
		"id", "title", "source", "domain", "publishedAt", "language", "region",
		"sentiment", "contentType", "eventId", "eventTitle", "url",
	}
	eventsHeader = []string{
		"id", "title", "status", "primaryTopic", "primaryEntity", "startAt",
		"lastAt", "heatScore", "credibilityScore", "itemCount",
		"authoritativeSourceCount", "uniqueSourceCount",
	}
)

// plainNumberPattern is the source /^-?\d+(\.\d+)?$/ guard: a plain decimal
// string is left alone even though it starts with + or -.
var plainNumberPattern = regexp.MustCompile(`^-?[0-9]+(\.[0-9]+)?$`)

// csvRowWriter streams the CSV body. The source builds [header, ...rows] and
// joins it with "\n", so this writer inserts LF only *between* lines: the
// output is UTF-8 without a BOM and has no trailing newline, and an empty
// result is the header line alone. Rows are written one at a time so the
// handler never materializes one large CSV string.
type csvRowWriter struct {
	w         io.Writer
	wroteLine bool
	err       error
}

// newCSVRowWriter wraps the response writer.
func newCSVRowWriter(w io.Writer) *csvRowWriter {
	return &csvRowWriter{w: w}
}

// writeRow encodes and writes one row, separated from the previous row by LF.
func (c *csvRowWriter) writeRow(cells []string) {
	if c.err != nil {
		return
	}
	if c.wroteLine {
		if _, err := io.WriteString(c.w, "\n"); err != nil {
			c.err = err
			return
		}
	}
	for index, cell := range cells {
		if index > 0 {
			if _, err := io.WriteString(c.w, ","); err != nil {
				c.err = err
				return
			}
		}
		if _, err := io.WriteString(c.w, escapeCSVValue(cell)); err != nil {
			c.err = err
			return
		}
	}
	c.wroteLine = true
}

// escapeCSVValue ports escapeCsvValue byte for byte.
//
// A formula-looking cell is prefixed with a single quote before the CSV
// quoting step: the leading JavaScript whitespace is skipped for the check,
// and a plain number (optionally negative) is left untouched, so -12 and -0.5
// stay numeric while +12, -1e3 and =SUM(...) are neutralized. The cell is then
// quoted only when it contains a comma, a double quote, CR or LF, with inner
// double quotes doubled; other whitespace and text stay as they are.
func escapeCSVValue(value string) string {
	trimmedStart := strings.TrimLeft(value, jsWhitespace)
	if trimmedStart != "" &&
		(trimmedStart[0] == '=' || trimmedStart[0] == '+' || trimmedStart[0] == '-' || trimmedStart[0] == '@') &&
		!plainNumberPattern.MatchString(trimmedStart) {
		return escapeCSVValue("'" + value)
	}
	if strings.ContainsAny(value, ",\"\n\r") {
		return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
	}
	return value
}

// formatJSNumber renders a number the way String(value) does for the bounded
// score/count ranges of both exports (0..100 scores, integer counts). Zero is
// normalized so a negative zero never leaks a "-0" cell.
func formatJSNumber(value float64) string {
	if value == 0 {
		return "0"
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}
