package classificationrssops

import (
	"crypto/rand"
	"encoding/hex"
	"math"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// jsISOLayout is the exact layout of JavaScript's Date.prototype.toISOString:
// millisecond precision, always three fractional digits, UTC.
const jsISOLayout = "2006-01-02T15:04:05.000Z"

// formatJSTime renders a time the way NestJS serializes a Date into JSON.
// Go's default RFC3339Nano marshalling drops trailing zeros, which would break
// field-by-field parity with NestJS responses.
func formatJSTime(value time.Time) string {
	return value.UTC().Format(jsISOLayout)
}

// nowMillis is the millisecond-truncated UTC clock used for row timestamps.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID builds an id for Prisma cuid columns written from Go. MySQL has no
// client-side default, so every insert must supply one; the shape matches the
// other Go batches (c + 24 hex characters).
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// rawStored reports whether a BSON field exists in the document at all. The zero
// bson.RawValue (Type 0) and BSON undefined mean the key is absent, which NestJS
// sees as undefined and JSON.stringify drops; an explicit BSON null is stored and
// must serialize as null.
func rawStored(value bson.RawValue) bool {
	return value.Type != 0 && value.Type != bson.TypeUndefined
}

// rawString mirrors the NestJS readString helper: only a stored string yields a
// value, and empty strings after trimming become nil.
func rawString(value bson.RawValue) *string {
	if value.Type != bson.TypeString {
		return nil
	}
	var text string
	if err := value.Unmarshal(&text); err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// rawNumber mirrors the NestJS readNumber helper: only a stored numeric BSON
// value yields a finite float64.
func rawNumber(value bson.RawValue) *float64 {
	switch value.Type {
	case bson.TypeDouble, bson.TypeInt32, bson.TypeInt64, bson.TypeDecimal128:
	default:
		return nil
	}
	var parsed float64
	if err := value.Unmarshal(&parsed); err != nil {
		return nil
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return nil
	}
	return &parsed
}

// rawBool mirrors an exact typeof check for booleans (no BSON coercion).
func rawBool(value bson.RawValue) *bool {
	if value.Type != bson.TypeBoolean {
		return nil
	}
	var parsed bool
	if err := value.Unmarshal(&parsed); err != nil {
		return nil
	}
	return &parsed
}

// rawTime mirrors the NestJS readDate helper: a BSON date, a parseable string
// or a numeric epoch are all accepted; anything else yields nil.
func rawTime(value bson.RawValue) *time.Time {
	switch value.Type {
	case bson.TypeDateTime:
		var parsed time.Time
		if err := value.Unmarshal(&parsed); err != nil {
			return nil
		}
		utc := parsed.UTC()
		return &utc
	case bson.TypeString:
		var text string
		if err := value.Unmarshal(&text); err != nil {
			return nil
		}
		return parseJSDate(text)
	case bson.TypeInt32, bson.TypeInt64, bson.TypeDouble, bson.TypeDecimal128:
		parsed := rawNumber(value)
		if parsed == nil || math.IsNaN(*parsed) || math.IsInf(*parsed, 0) {
			return nil
		}
		millis := int64(math.Trunc(*parsed))
		result := time.UnixMilli(millis).UTC()
		return &result
	}
	return nil
}

// rawIDString normalizes an _id that may be a BSON ObjectId or a plain string.
// The classification collections are keyed by ObjectId, but the samples and the
// report results also store string references, so both shapes are accepted.
func rawIDString(value bson.RawValue) string {
	switch value.Type {
	case bson.TypeObjectID:
		var id bson.ObjectID
		if err := value.Unmarshal(&id); err == nil {
			return id.Hex()
		}
	case bson.TypeString:
		var text string
		if err := value.Unmarshal(&text); err == nil {
			return text
		}
	}
	return ""
}

// rawConfidence mirrors the NestJS readConfidence helper: a finite number
// clamped to [0, 1] and rounded to four decimal places, otherwise nil.
func rawConfidence(value bson.RawValue) *float64 {
	parsed := rawNumber(value)
	if parsed == nil {
		return nil
	}
	clamped := math.Max(0, math.Min(1, round4(*parsed)))
	return &clamped
}

// rawStringArray mirrors the NestJS readStringArray helper: non-array values
// yield an empty slice, entries are trimmed, deduplicated and capped at 1000.
func rawStringArray(value bson.RawValue) []string {
	if value.Type != bson.TypeArray {
		return []string{}
	}
	var rawItems []bson.RawValue
	if err := value.Unmarshal(&rawItems); err != nil {
		return []string{}
	}
	seen := make(map[string]bool, len(rawItems))
	out := make([]string, 0, len(rawItems))
	for _, item := range rawItems {
		text := rawString(item)
		if text == nil || seen[*text] {
			continue
		}
		seen[*text] = true
		out = append(out, *text)
		if len(out) >= 1000 {
			break
		}
	}
	return out
}

// parseJSDate accepts the string shapes JavaScript's Date constructor accepts
// for the values this API produces (ISO 8601 with or without milliseconds and
// date-only strings). Anything else yields nil, exactly like an Invalid Date.
func parseJSDate(raw string) *time.Time {
	text := strings.TrimSpace(raw)
	if text == "" {
		return nil
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999Z07:00",
		"2006-01-02T15:04:05",
		"2006-01-02",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, text); err == nil {
			utc := parsed.UTC()
			return &utc
		}
	}
	return nil
}

// jsNumber mirrors JavaScript's Number(string) coercion for query parameters.
// It accepts surrounding whitespace, decimal and scientific notation, the
// 0x/0b/0o prefixes, and Infinity/NaN. Underscores are rejected because
// JavaScript's Number() yields NaN for them.
func jsNumber(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	if strings.ContainsRune(trimmed, '_') {
		return 0, false
	}
	lower := strings.ToLower(trimmed)
	unsigned := strings.TrimLeft(trimmed, "+-")
	if len(lower) >= 2 && lower[0] == '0' && (lower[1] == 'x' || lower[1] == 'b' || lower[1] == 'o') {
		base := 8
		switch lower[1] {
		case 'x':
			base = 16
		case 'b':
			base = 2
		}
		digits := unsigned[2:]
		if digits == "" {
			return 0, false
		}
		parsed, err := strconv.ParseInt(digits, base, 64)
		if err != nil {
			return 0, false
		}
		if strings.HasPrefix(trimmed, "-") {
			return -float64(parsed), true
		}
		return float64(parsed), true
	}
	switch trimmed {
	case "Infinity", "+Infinity":
		return math.Inf(1), true
	case "-Infinity":
		return math.Inf(-1), true
	case "NaN":
		return math.NaN(), true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// finiteNumber mirrors Number.isFinite(Number(raw)) with the empty string
// treated as "not supplied".
func finiteNumber(raw string) (float64, bool) {
	if raw == "" {
		return 0, false
	}
	parsed, ok := jsNumber(raw)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}
