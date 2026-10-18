package situationsignals

import (
	"encoding/json"
	"strings"
)

// monitorCandidate is the matcher's input document, mirroring the
// MonitorCandidate interface of situation-monitor-monitors.service.ts.
type monitorCandidate struct {
	ItemKey    string
	ItemType   string
	ItemMetaID string
	Title      string
	TitleZh    string
	Summary    string
	SummaryZh  string
	Link       string
	Source     string
	Timestamp  float64
	Category   string
	Topics     []string
	Entities   []string
	Location   string
	GeoTexts   []string
	ExtraTexts []string
}

// telegramItemFields is the loose projection of a cached Telegram item. The
// cached items are written by the NestJS Telegram poller, not by this package,
// so every field is optional and read on demand.
type telegramItemFields struct {
	ID           rawJSON      `json:"id"`
	Channel      rawJSON      `json:"channel"`
	ChannelTitle rawJSON      `json:"channelTitle"`
	URL          rawJSON      `json:"url"`
	TS           rawJSON      `json:"ts"`
	Text         rawJSON      `json:"text"`
	Topic        rawJSON      `json:"topic"`
	Tags         jsStringList `json:"tags"`
}

// decodeTelegramItem decodes one cached item.
func decodeTelegramItem(item rawJSON) telegramItemFields {
	var fields telegramItemFields
	if err := json.Unmarshal(item.raw, &fields); err != nil {
		return telegramItemFields{}
	}
	return fields
}

// stringOrEmpty resolves a loose string field.
func stringOrEmpty(raw rawJSON) string {
	text, _ := raw.asString()
	return text
}

// telegramCandidate mirrors telegramCandidate.
//
// `title` is the first 120 UTF-16 code units of the text, falling back to the
// channel title. `timestamp` falls back to the current time when `ts` does not
// parse, which is what Date.parse(item.ts) || Date.now() does.
func telegramCandidate(item rawJSON) monitorCandidate {
	fields := decodeTelegramItem(item)
	text := stringOrEmpty(fields.Text)
	channelTitle := stringOrEmpty(fields.ChannelTitle)
	topic := stringOrEmpty(fields.Topic)

	title := clipUTF16(text, 120)
	if title == "" {
		title = channelTitle
	}
	timestamp := jsDateParseOrNow(stringOrEmpty(fields.TS))
	topics := []string{}
	if topic != "" {
		topics = append(topics, topic)
	}
	return monitorCandidate{
		ItemKey:    "telegram:" + stringOrEmpty(fields.ID),
		ItemType:   "telegram",
		Title:      title,
		Summary:    text,
		Link:       stringOrEmpty(fields.URL),
		Source:     channelTitle,
		Timestamp:  float64(timestamp.UnixMilli()),
		Category:   topic,
		Topics:     topics,
		Entities:   []string{},
		GeoTexts:   []string{},
		ExtraTexts: fields.Tags.Values(),
	}
}

// orefAlertFields is the loose projection of a cached OREF alert.
type orefAlertFields struct {
	ID        rawJSON `json:"id"`
	Cat       rawJSON `json:"cat"`
	Title     rawJSON `json:"title"`
	Data      rawJSON `json:"data"`
	Desc      rawJSON `json:"desc"`
	AlertDate rawJSON `json:"alertDate"`
}

// orefHistoryEntryFields is the loose projection of one history entry.
type orefHistoryEntryFields struct {
	Alerts    rawJSON `json:"alerts"`
	Timestamp rawJSON `json:"timestamp"`
}

// decodeOrefAlert decodes one cached alert.
func decodeOrefAlert(alert rawJSON) orefAlertFields {
	var fields orefAlertFields
	if err := json.Unmarshal(alert.raw, &fields); err != nil {
		return orefAlertFields{}
	}
	return fields
}

// orefCandidateAreas mirrors `Array.isArray(alert.data) ? alert.data : []`.
func orefCandidateAreas(fields orefAlertFields) []string {
	values, ok := fields.Data.asArray()
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		text, ok := (rawJSON{raw: value}).asString()
		if !ok {
			continue
		}
		out = append(out, text)
	}
	return out
}

// orefAlertCandidate mirrors orefAlertCandidate(alert, itemType).
func orefAlertCandidate(alert rawJSON, itemType string) monitorCandidate {
	fields := decodeOrefAlert(alert)
	areas := orefCandidateAreas(fields)
	category := stringOrEmpty(fields.Cat)
	source := category
	if source == "" {
		source = "oref"
	}
	// The shared Jerusalem-zone converter is used instead of a naive parse:
	// OREF emits "YYYY-MM-DD HH:mm:ss" wall-clock times with no zone.
	timestamp := jsDateParseOrNow(orefDateToUTC(stringOrEmpty(fields.AlertDate)))
	return monitorCandidate{
		ItemKey:    "oref:" + stringOrEmpty(fields.ID),
		ItemType:   itemType,
		Title:      stringOrEmpty(fields.Title),
		Summary:    stringOrEmpty(fields.Desc),
		Link:       "",
		Source:     source,
		Timestamp:  float64(timestamp.UnixMilli()),
		Category:   category,
		Topics:     []string{},
		Entities:   []string{},
		GeoTexts:   areas,
		ExtraTexts: areas,
	}
}

// orefHistoryCandidate mirrors orefHistoryCandidate(alert, entry).
func orefHistoryCandidate(alert rawJSON, entry rawJSON) monitorCandidate {
	var entryFields orefHistoryEntryFields
	_ = json.Unmarshal(entry.raw, &entryFields)
	candidate := orefAlertCandidate(alert, "oref_history")
	entryTimestamp := stringOrEmpty(entryFields.Timestamp)
	if parsed, ok := parseJSTime(jsonStringValue(orefDateToUTC(entryTimestamp))); ok && parsed.UnixMilli() != 0 {
		candidate.Timestamp = float64(parsed.UnixMilli())
	}
	candidate.ItemKey = "oref-history:" + entryTimestamp + ":" + stringOrEmpty(decodeOrefAlert(alert).ID)
	return candidate
}

// candidateEmbeddingText mirrors candidateEmbeddingText.
func candidateEmbeddingText(candidate monitorCandidate) string {
	parts := []string{"title=" + candidate.Title}
	if candidate.Summary != "" {
		parts = append(parts, "summary="+candidate.Summary)
	}
	if len(candidate.Topics) > 0 {
		parts = append(parts, "topics="+strings.Join(candidate.Topics, ", "))
	}
	if len(candidate.Entities) > 0 {
		parts = append(parts, "entities="+strings.Join(candidate.Entities, ", "))
	}
	if candidate.Location != "" {
		parts = append(parts, "location="+candidate.Location)
	}
	if len(candidate.ExtraTexts) > 0 {
		parts = append(parts, "extra="+strings.Join(candidate.ExtraTexts, " | "))
	}
	parts = append(parts, "source="+candidate.Source)
	return strings.Join(parts, "\n")
}

// buildHaystack mirrors buildHaystack.
func buildHaystack(candidate monitorCandidate) string {
	parts := []string{
		candidate.Title,
		candidate.TitleZh,
		candidate.Summary,
		candidate.SummaryZh,
		candidate.Source,
		candidate.Location,
		candidate.Category,
	}
	parts = append(parts, candidate.Topics...)
	parts = append(parts, candidate.Entities...)
	parts = append(parts, candidate.ExtraTexts...)
	return strings.ToLower(strings.Join(parts, " "))
}
