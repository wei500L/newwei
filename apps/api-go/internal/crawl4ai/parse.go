package crawl4ai

import (
	"encoding/json"
	"strconv"
	"time"
)

// rawResponse is the wire shape of POST /crawl. Only the fields the discovery
// chain reads are decoded; unknown keys are ignored like the NestJS normalize
// step.
type rawResponse struct {
	Results      []rawArticle  `json:"results"`
	Warnings     []string      `json:"warnings"`
	SystemEvents []SystemEvent `json:"systemEvents"`
}

type rawArticle struct {
	URL               string          `json:"url"`
	Success           *bool           `json:"success"`
	StatusCode        *int            `json:"statusCode"`
	StatusCodeSnake   *int            `json:"status_code"`
	Error             string          `json:"error"`
	ErrorMessage      string          `json:"errorMessage"`
	ErrorMessageSnake string          `json:"error_message"`
	Links             json.RawMessage `json:"links"`
	Markdown          json.RawMessage `json:"markdown"`
	Metadata          json.RawMessage `json:"metadata"`
}

type rawLink struct {
	Href            string   `json:"href"`
	URL             string   `json:"url"`
	Text            string   `json:"text"`
	Title           string   `json:"title"`
	Rel             string   `json:"rel"`
	TotalScore      *float64 `json:"total_score"`
	TotalScoreCamel *float64 `json:"totalScore"`
	ContextualScore *float64 `json:"contextual_score"`
	ContextualCamel *float64 `json:"contextualScore"`
	IntrinsicScore  *float64 `json:"intrinsic_score"`
	IntrinsicCamel  *float64 `json:"intrinsicScore"`
}

// normalizeResponse decodes and normalizes the /crawl body. A body that is not
// valid JSON is a request failure (the caller reports it as a crawl error).
func normalizeResponse(data []byte) (Response, error) {
	var decoded rawResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		return Response{}, &httpStatusError{status: 0, body: nil}
	}
	response := Response{
		Results:      make([]Article, 0, len(decoded.Results)),
		Warnings:     decoded.Warnings,
		SystemEvents: make([]SystemEvent, 0, len(decoded.SystemEvents)),
	}
	if response.Warnings == nil {
		response.Warnings = []string{}
	}
	for _, event := range decoded.SystemEvents {
		if event.Level == "" || event.EventType == "" || event.Message == "" || event.Timestamp == "" {
			continue
		}
		response.SystemEvents = append(response.SystemEvents, event)
	}
	for _, entry := range decoded.Results {
		article := Article{
			URL:      entry.URL,
			Success:  entry.Success,
			Links:    decodeLinks(entry.Links),
			Metadata: entry.Metadata,
			Markdown: decodeMarkdown(entry.Markdown),
		}
		switch {
		case entry.StatusCode != nil:
			article.StatusCode = entry.StatusCode
		case entry.StatusCodeSnake != nil:
			article.StatusCode = entry.StatusCodeSnake
		}
		article.Error = firstNonEmpty(entry.ErrorMessage, entry.ErrorMessageSnake, entry.Error)
		response.Results = append(response.Results, article)
	}
	return response, nil
}

// decodeLinks flattens every link bucket, keeping only array buckets, exactly
// like normalizeLinkRecord.
func decodeLinks(raw json.RawMessage) []Link {
	trimmed := trimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	var buckets map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &buckets); err != nil {
		return nil
	}
	links := []Link{}
	for _, bucketRaw := range buckets {
		var entries []rawLink
		if err := json.Unmarshal(bucketRaw, &entries); err != nil {
			continue
		}
		for _, entry := range entries {
			href := entry.Href
			if href == "" {
				href = entry.URL
			}
			if href == "" {
				continue
			}
			links = append(links, Link{
				Href:            href,
				Text:            entry.Text,
				Title:           entry.Title,
				Rel:             entry.Rel,
				TotalScore:      firstNumber(entry.TotalScore, entry.TotalScoreCamel),
				ContextualScore: firstNumber(entry.ContextualScore, entry.ContextualCamel),
				IntrinsicScore:  firstNumber(entry.IntrinsicScore, entry.IntrinsicCamel),
			})
		}
	}
	if len(links) == 0 {
		return nil
	}
	return links
}

// decodeMarkdown accepts both the string and object shapes of Crawl4aiArticle.
// Discovery never reads it, but keeping it lets the caller log or persist a
// prefetched body without a second request.
func decodeMarkdown(raw json.RawMessage) string {
	trimmed := trimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err == nil {
			return text
		}
		return ""
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &record); err != nil {
		return ""
	}
	for _, key := range []string{"raw_markdown", "rawMarkdown", "markdown", "fit_markdown", "fitMarkdown", "text"} {
		value, ok := record[key]
		if !ok {
			continue
		}
		var text string
		if err := json.Unmarshal(value, &text); err == nil && text != "" {
			return text
		}
	}
	return ""
}

func firstNumber(values ...*float64) *float64 {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func trimSpace(raw json.RawMessage) json.RawMessage {
	start := 0
	end := len(raw)
	for start < end && isSpace(raw[start]) {
		start++
	}
	for end > start && isSpace(raw[end-1]) {
		end--
	}
	return raw[start:end]
}

func isSpace(char byte) bool {
	return char == ' ' || char == '\t' || char == '\n' || char == '\r'
}

// nestNow formats an instant like `new Date().toISOString()`.
func nestNow(unixMilli int64) string {
	return time.UnixMilli(unixMilli).UTC().Format("2006-01-02T15:04:05.000Z")
}

func itoa(value int) string {
	return strconv.Itoa(value)
}
