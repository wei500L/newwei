package situationsignalsworker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// sourceTelegram is the fixed source tag of a Telegram feed item.
const sourceTelegram = "telegram"

// nestISOLayout is the JavaScript Date.prototype.toISOString layout: UTC,
// always three fractional digits and a trailing Z.
const nestISOLayout = "2006-01-02T15:04:05.000Z"

// defaultTelegramItemTopic is the NestJS fallback for a channel without topic.
const defaultTelegramItemTopic = "other"

// TelegramItem is one normalized Telegram signal, byte-compatible with
// TelegramSignalItem in situation-monitor-signals.types.ts and with the cached
// state document. Field order is the JSON key order NestJS writes.
type TelegramItem struct {
	ID           string   `json:"id"`
	Source       string   `json:"source"`
	Channel      string   `json:"channel"`
	ChannelTitle string   `json:"channelTitle"`
	URL          string   `json:"url"`
	TS           string   `json:"ts"`
	Text         string   `json:"text"`
	Topic        string   `json:"topic"`
	Tags         []string `json:"tags"`
	EarlySignal  bool     `json:"earlySignal"`
}

// nestISOTimeMillis renders one Unix-millisecond instant like
// Date.prototype.toISOString.
func nestISOTimeMillis(milliseconds int64) string {
	return time.UnixMilli(milliseconds).UTC().Format(nestISOLayout)
}

// nestISOTimeFloat mirrors `new Date(value).toISOString()` for a JavaScript
// number of milliseconds. JavaScript truncates the fractional part when it
// builds the date, so the value is truncated before conversion.
func nestISOTimeFloat(milliseconds float64) string {
	if math.IsNaN(milliseconds) || math.IsInf(milliseconds, 0) {
		return nestISOTimeMillis(time.Now().UnixMilli())
	}
	return nestISOTimeMillis(int64(math.Trunc(milliseconds)))
}

// jsSliceUTF16 mirrors String.prototype.slice(0, limit): the string is measured
// and cut in UTF-16 code units, so cutting through a surrogate pair produces
// U+FFFD exactly like JavaScript. This matters for Telegram text with emoji:
// maxTextChars counts code units, not runes.
func jsSliceUTF16(value string, limit int) string {
	if limit < 0 {
		limit = 0
	}
	encoded := utf16.Encode([]rune(value))
	if len(encoded) <= limit {
		return value
	}
	return string(utf16.Decode(encoded[:limit]))
}

// stripBOM mirrors stripBom: only the first U+FEFF character is removed.
// NodeJS decodes the UTF-8 response body to a string first, where a UTF-8 BOM
// (EF BB BF) becomes U+FEFF, so the byte prefix and the decoded prefix are the
// same thing.
func stripBOM(text string) string {
	return strings.TrimPrefix(text, "\uFEFF")
}

// orefErrorRedactionPattern mirrors /\/\/[^@]+@/g: it removes credentials from
// a proxy URL inside an error message.
var orefErrorRedactionPattern = regexp.MustCompile(`//[^@]+@`)

// redactOrefError mirrors redactOrefError: proxy credentials embedded in a URL
// are replaced before the message is cached or returned.
func redactOrefError(message string) string {
	return orefErrorRedactionPattern.ReplaceAllString(message, "//<redacted>@")
}

// marshalJSONNoEscape encodes a value exactly like JSON.stringify does for the
// characters that matter here: no HTML escaping of <, > and & and no trailing
// newline. encoding/json escapes those three by default, which would make the
// cache documents and the event bridge payload diverge from NestJS bytes.
func marshalJSONNoEscape(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	encoded := buffer.Bytes()
	if len(encoded) > 0 && encoded[len(encoded)-1] == '\n' {
		encoded = encoded[:len(encoded)-1]
	}
	return encoded, nil
}

// compactJSON re-encodes a JSON value without insignificant whitespace, which
// is what JSON.stringify produces. It fails on invalid JSON.
func compactJSON(raw []byte) ([]byte, error) {
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// parseJSTimeString mirrors Date.parse for the ISO-8601 timestamps the cached
// documents carry (both implementations always write toISOString output).
// It reports Unix milliseconds and false for unparseable input.
func parseJSTimeString(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, trimmed)
	if err != nil {
		return 0, false
	}
	return parsed.UnixMilli(), true
}

// jsStringOr mirrors `String(value ?? fallback)` for the JSON types OREF
// history records actually contain (strings, null, numbers, booleans). An
// object becomes "[object Object]" and an array is joined with commas exactly
// like Array.prototype.toString so no untyped container ever leaks into the
// normalized history.
func jsStringOr(raw json.RawMessage, fallback string) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return fallback
	}
	switch trimmed[0] {
	case '"':
		var value string
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return fallback
		}
		return value
	case 't':
		return "true"
	case 'f':
		return "false"
	case '{':
		return "[object Object]"
	case '[':
		var elements []json.RawMessage
		if err := json.Unmarshal(trimmed, &elements); err != nil {
			return fallback
		}
		parts := make([]string, 0, len(elements))
		for _, element := range elements {
			parts = append(parts, jsStringOr(element, ""))
		}
		return strings.Join(parts, ",")
	default:
		// Numbers keep their literal text, which is what String() does for a
		// JavaScript number parsed from JSON.
		return string(trimmed)
	}
}

// normalizeTelegramMessage mirrors normalizeTelegramMessage.
//
// The caller has already trimmed the raw message text to decide whether the
// message has text at all; the normalized text is the *raw* text sliced to
// maxTextChars UTF-16 code units and is deliberately not trimmed (NestJS keeps
// the upstream whitespace in the feed item).
func normalizeTelegramMessage(message telegramclient.Message, channel TelegramChannelConfig, handle string, maxTextChars int) TelegramItem {
	text := jsSliceUTF16(message.Text, maxTextChars)

	// NestJS checks Number.isFinite(message.date); the contract models the date
	// as a concrete unix second count, so every value (including the epoch) is
	// finite and maps to a timestamp.
	timestamp := nestISOTimeMillis(message.DateUnix * 1000)

	topic := channel.Topic
	if topic == "" {
		topic = defaultTelegramItemTopic
	}
	title := channel.Label
	if title == "" {
		title = handle
	}
	tags := make([]string, 0, 1)
	if channel.Region != "" {
		tags = append(tags, channel.Region)
	}
	return TelegramItem{
		ID:           fmt.Sprintf("%s:%d", handle, message.ID),
		Source:       sourceTelegram,
		Channel:      handle,
		ChannelTitle: title,
		URL:          fmt.Sprintf("https://t.me/%s/%d", handle, message.ID),
		TS:           timestamp,
		Text:         text,
		Topic:        topic,
		Tags:         tags,
		EarlySignal:  true,
	}
}

// normalizeTelegramHandle mirrors `handle.replace(/^@/, "")` followed by trim:
// exactly one leading @ is removed.
func normalizeTelegramHandle(handle string) string {
	return strings.TrimSpace(strings.TrimPrefix(handle, "@"))
}

// intString renders a decimal int with strconv-free call sites.
func intString(value int64) string {
	return strconv.FormatInt(value, 10)
}
