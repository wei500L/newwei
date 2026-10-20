// Package newsnowsources serves the two NewsNow source HTTP endpoints that
// fetch and cache upstream data: GET /api/news-aggregator/source and
// POST /api/news-aggregator/sources/batch.
//
// The package owns the complete cold-fetch path: source id validation, alias
// redirect resolution, runtime secret lookup, per-provider upstream requests,
// item normalisation, the compatible fresh/stale Redis cache, the refresh lock,
// the continuous batch worker pool and the source-refresh Redis relay consumed
// by NestJS. It deliberately does not own the warm scheduler, the hottest
// analysis scheduler, recommendations or any general WebSocket concern.
package newsnowsources

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// SourceStatus is the two-value status of a source response. The cached
// document stores "success"; a cache hit returns "cache" without rewriting the
// stored projection.
type SourceStatus string

const (
	// StatusSuccess marks a freshly fetched response.
	StatusSuccess SourceStatus = "success"
	// StatusCache marks a response served from Redis.
	StatusCache SourceStatus = "cache"
)

// ValueKind discriminates the JSON union shapes shared by item ids and dates.
// Numbers keep their exact JSON literal so a numeric id is never converted to a
// string (and a zero id is never mistaken for a missing one).
type ValueKind int

const (
	// ValueAbsent is a missing member.
	ValueAbsent ValueKind = iota
	// ValueNull is an explicit JSON null.
	ValueNull
	// ValueString is a JSON string.
	ValueString
	// ValueNumber is a JSON number kept as its original literal.
	ValueNumber
)

// IDValue is a string-or-number item id. Both shapes marshal back unchanged.
type IDValue struct {
	Kind ValueKind
	Text string
}

// StringID builds a string id.
func StringID(value string) IDValue { return IDValue{Kind: ValueString, Text: value} }

// NumberID builds a numeric id from its JSON literal.
func NumberID(literal string) IDValue { return IDValue{Kind: ValueNumber, Text: literal} }

// String returns the id text used for dedupe sets and relay counting, mirroring
// String(item.id) in the NestJS dispatcher.
func (v IDValue) String() string { return v.Text }

// MarshalJSON preserves the id shape.
func (v IDValue) MarshalJSON() ([]byte, error) {
	switch v.Kind {
	case ValueString:
		return json.Marshal(v.Text)
	case ValueNumber:
		if !json.Valid([]byte(v.Text)) {
			return nil, fmt.Errorf("newsnowsources: invalid numeric id %q", v.Text)
		}
		return []byte(v.Text), nil
	default:
		return []byte("null"), nil
	}
}

// UnmarshalJSON accepts exactly the two id shapes.
func (v *IDValue) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		v.Kind = ValueNull
		v.Text = ""
		return nil
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return err
		}
		v.Kind = ValueString
		v.Text = text
		return nil
	}
	if !json.Valid(trimmed) {
		return errors.New("newsnowsources: invalid id value")
	}
	v.Kind = ValueNumber
	v.Text = string(trimmed)
	return nil
}

// DateValue is a number-or-string timestamp. Provenance fields such as
// extra.date and pubDate keep whichever shape the provider produced: several
// HTML providers fall back to the original relative-date string when the date
// cannot be parsed, and that string must survive the JSON round trip.
type DateValue struct {
	Kind ValueKind
	Text string
}

// Millis builds a numeric millisecond timestamp.
func Millis(value int64) DateValue {
	return DateValue{Kind: ValueNumber, Text: strconv.FormatInt(value, 10)}
}

// StringDate builds a string timestamp.
func StringDate(value string) DateValue { return DateValue{Kind: ValueString, Text: value} }

// NullDate is the explicit null produced when JavaScript would serialise NaN.
func NullDate() DateValue { return DateValue{Kind: ValueNull} }

// Number returns the numeric value and whether the value is a usable number.
func (v DateValue) Number() (float64, bool) {
	switch v.Kind {
	case ValueNumber:
		value, err := strconv.ParseFloat(v.Text, 64)
		if err != nil {
			return 0, false
		}
		return value, true
	case ValueString:
		value, err := strconv.ParseFloat(strings.TrimSpace(v.Text), 64)
		if err != nil {
			return 0, false
		}
		return value, true
	default:
		return 0, false
	}
}

// StringValue returns the string shape, if any.
func (v DateValue) StringValue() (string, bool) {
	if v.Kind == ValueString {
		return v.Text, true
	}
	return "", false
}

// MarshalJSON preserves the timestamp shape.
func (v DateValue) MarshalJSON() ([]byte, error) {
	switch v.Kind {
	case ValueString:
		return json.Marshal(v.Text)
	case ValueNumber:
		if !json.Valid([]byte(v.Text)) {
			return nil, fmt.Errorf("newsnowsources: invalid numeric timestamp %q", v.Text)
		}
		return []byte(v.Text), nil
	default:
		return []byte("null"), nil
	}
}

// UnmarshalJSON accepts number, string and null timestamps, which is what the
// compatible cache can contain.
func (v *DateValue) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		v.Kind = ValueNull
		v.Text = ""
		return nil
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return err
		}
		v.Kind = ValueString
		v.Text = text
		return nil
	}
	if !json.Valid(trimmed) {
		return errors.New("newsnowsources: invalid timestamp value")
	}
	v.Kind = ValueNumber
	v.Text = string(trimmed)
	return nil
}

// InfoValue is the extra.info union: false, a string, or absent. false must
// survive serialisation, so it cannot be modelled with omitempty on a string.
type InfoValue struct {
	Kind ValueKind
	Text string
	Bool bool
}

// InfoText builds a string info badge.
func InfoText(value string) *InfoValue { return &InfoValue{Kind: ValueString, Text: value} }

// InfoBool builds the boolean info badge (jin10 emits false for non-important
// flashes).
func InfoBool(value bool) *InfoValue { return &InfoValue{Kind: ValueNumber, Bool: value} }

// MarshalJSON writes string, boolean or null.
func (v InfoValue) MarshalJSON() ([]byte, error) {
	switch v.Kind {
	case ValueString:
		return json.Marshal(v.Text)
	case ValueNumber:
		if v.Bool {
			return []byte("true"), nil
		}
		return []byte("false"), nil
	default:
		return []byte("null"), nil
	}
}

// UnmarshalJSON accepts string and boolean cached values.
func (v *InfoValue) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		v.Kind = ValueNull
		return nil
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return err
		}
		v.Kind = ValueString
		v.Text = text
	case 't', 'f':
		var flag bool
		if err := json.Unmarshal(trimmed, &flag); err != nil {
			return err
		}
		v.Kind = ValueNumber
		v.Bool = flag
	default:
		return errors.New("newsnowsources: invalid info value")
	}
	return nil
}

// IconShape discriminates the three icon shapes.
type IconShape int

const (
	// IconAbsent omits the icon member.
	IconAbsent IconShape = iota
	// IconString is a plain image URL.
	IconString
	// IconObject is {url, scale}.
	IconObject
	// IconBool is the literal false.
	IconBool
	// IconNull is an explicit null.
	IconNull
)

// IconValue is extra.icon: false, a URL string, or a {url, scale} object.
type IconValue struct {
	Shape IconShape
	URL   string
	Scale json.RawMessage
	Bool  bool
}

// IconURL builds a string icon.
func IconURL(value string) *IconValue { return &IconValue{Shape: IconString, URL: value} }

// IconFalse builds the literal false icon.
func IconFalse() *IconValue { return &IconValue{Shape: IconBool, Bool: false} }

// IconScaled builds the {url, scale} object.
func IconScaled(url string, scale json.RawMessage) *IconValue {
	return &IconValue{Shape: IconObject, URL: url, Scale: scale}
}

// MarshalJSON writes the icon shape.
func (v IconValue) MarshalJSON() ([]byte, error) {
	switch v.Shape {
	case IconString:
		return json.Marshal(v.URL)
	case IconBool:
		if v.Bool {
			return []byte("true"), nil
		}
		return []byte("false"), nil
	case IconObject:
		scale := v.Scale
		if len(scale) == 0 {
			scale = json.RawMessage("1")
		}
		var buf bytes.Buffer
		buf.WriteByte('{')
		encodedURL, err := json.Marshal(v.URL)
		if err != nil {
			return nil, err
		}
		buf.WriteString(`"url":`)
		buf.Write(encodedURL)
		buf.WriteString(`,"scale":`)
		buf.Write(scale)
		buf.WriteByte('}')
		return buf.Bytes(), nil
	default:
		return []byte("null"), nil
	}
}

// UnmarshalJSON accepts false, string and {url, scale} values.
func (v *IconValue) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		v.Shape = IconNull
		return nil
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return err
		}
		v.Shape = IconString
		v.URL = text
	case 't', 'f':
		var flag bool
		if err := json.Unmarshal(trimmed, &flag); err != nil {
			return err
		}
		v.Shape = IconBool
		v.Bool = flag
	case '{':
		var object struct {
			URL   string          `json:"url"`
			Scale json.RawMessage `json:"scale"`
		}
		if err := json.Unmarshal(trimmed, &object); err != nil {
			return err
		}
		v.Shape = IconObject
		v.URL = object.URL
		v.Scale = object.Scale
	default:
		return errors.New("newsnowsources: invalid icon value")
	}
	return nil
}

// Extra carries the typed extension fields the reachable providers emit. The
// union members keep false/string/object/absent semantics instead of collapsing
// everything to strings.
type Extra struct {
	Hover *string    `json:"hover,omitempty"`
	Date  *DateValue `json:"date,omitempty"`
	Info  *InfoValue `json:"info,omitempty"`
	Diff  *DateValue `json:"diff,omitempty"`
	Icon  *IconValue `json:"icon,omitempty"`
	Tag   *string    `json:"tag,omitempty"`
}

// NewsItem mirrors the NestJS NewsItem contract.
type NewsItem struct {
	ID        IDValue    `json:"id"`
	Title     string     `json:"title"`
	URL       string     `json:"url"`
	MobileURL *string    `json:"mobileUrl,omitempty"`
	PubDate   *DateValue `json:"pubDate,omitempty"`
	Extra     *Extra     `json:"extra,omitempty"`
}

// SourceResponse is the compatible cache document. Items is always an array.
type SourceResponse struct {
	Status      SourceStatus `json:"status"`
	ID          string       `json:"id"`
	UpdatedTime DateValue    `json:"updatedTime"`
	Items       []NewsItem   `json:"items"`
}

// EnsureItemsArray turns a nil item slice into an empty array so the response
// encodes [] rather than null.
func (r *SourceResponse) EnsureItemsArray() {
	if r.Items == nil {
		r.Items = []NewsItem{}
	}
}

// RuntimeContext is what one provider invocation receives. Secrets are the
// merged runtime secrets for the requested and resolved source ids.
type RuntimeContext struct {
	SourceID          string
	RequestedSourceID string
	Secrets           map[string]string
}

// Getter fetches and maps one upstream source into news items.
type Getter func(ctx context.Context, rc RuntimeContext) ([]NewsItem, error)
