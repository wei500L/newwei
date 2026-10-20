package gdeltsnapshot

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
)

// isoTime formats an instant like Date.prototype.toISOString: UTC, millisecond
// precision, trailing Z. Every timestamp in the payload and in the status
// summary goes through this function.
func isoTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// isoTimePtr formats an optional instant; nil stays nil so the JSON value is
// null.
func isoTimePtr(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := isoTime(*value)
	return &formatted
}

// marshalJSON mirrors JSON.stringify: no HTML escaping and no trailing newline.
// The snapshot caches compare raw values, so the encoder detail matters.
func marshalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

// parseISOTime is the Date.parse equivalent used for expiry checks. Only the
// ISO-8601 shape this service writes is accepted; anything else counts as
// expired (Date.parse returns NaN for it).
func parseISOTime(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, false
	}
	return parsed.UTC(), true
}

// isExpired mirrors isExpired: an unparsable or not-in-the-future expiry is
// expired.
func isExpired(expiresAt string, now time.Time) bool {
	expiry, ok := parseISOTime(expiresAt)
	if !ok {
		return true
	}
	return !expiry.After(now)
}

// newRowID writes a Prisma cuid-shaped primary key. The column has no database
// default, so a client-side id is required on every insert.
func newRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

// newLockToken produces a random version 4 UUID, the shape Node's randomUUID
// gives the CacheService lease token.
func newLockToken() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x",
		buffer[0:4], buffer[4:6], buffer[6:8], buffer[8:10], buffer[10:16]), nil
}

// jsonString decodes a JSON string leaf. ok is false when the document is not a
// string, which is how the NestJS typeof checks behave.
func jsonString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// jsonNumber decodes a JSON number leaf.
func jsonNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// jsonArray decodes a JSON array leaf. ok is false when the document is not an
// array, which mirrors Array.isArray.
func jsonArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var value []json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	return value, true
}

// jsonObject reports whether a JSON leaf is an object, mirroring
// `value !== null && typeof value === "object"` for a parsed document.
func jsonObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// jsTruthy is Boolean(value) for a parsed JSON document: false, null, 0, NaN
// and "" are falsy; arrays and objects are truthy.
func jsTruthy(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" || string(trimmed) == "false" {
		return false
	}
	if string(trimmed) == "true" {
		return true
	}
	if trimmed[0] == '"' {
		text, ok := jsonString(trimmed)
		return ok && text != ""
	}
	if trimmed[0] == '[' || trimmed[0] == '{' {
		return true
	}
	number, ok := jsonNumber(trimmed)
	if !ok {
		return false
	}
	return number != 0 && !math.IsNaN(number)
}

// roundOneDecimal implements Math.round(value * 10) / 10. Every input of this
// helper is non-negative, so Go's half-away-from-zero rounding and
// Math.round's half-up rounding agree, including the exact .05 ties that the
// rate and average metrics can produce.
func roundOneDecimal(value float64) float64 {
	return math.Round(value*10) / 10
}
