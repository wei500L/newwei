package assistantruns

import (
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// This file is a verbatim port of AssistantPromptService. Prompt text,
// separators, JSON payload shapes and schema names must stay byte-identical:
// they are part of the model contract and the query planner branches depend on
// it.

// assistantQueryPlanSchema is zodToJsonSchema(AssistantQueryPlanSchema,
// {$refStrategy:"none"}): a discriminated union renders as anyOf of strict
// object schemas.
var assistantQueryPlanSchema = json.RawMessage(`{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "const": "news_negative_list" },
        "topic": { "type": "string", "minLength": 1 },
        "lookbackDays": { "type": "integer", "minimum": 1, "maximum": 90 },
        "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
      },
      "required": ["kind", "topic"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "const": "correlation_gold_usd" },
        "lookbackDays": { "type": "integer", "minimum": 7, "maximum": 3650 },
        "transform": { "type": "string", "enum": ["return", "level"] }
      },
      "required": ["kind"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "const": "correlation_two_series" },
        "seriesA": { "type": "string", "minLength": 1 },
        "seriesB": { "type": "string", "minLength": 1 },
        "lookbackDays": { "type": "integer", "minimum": 7, "maximum": 3650 },
        "transform": { "type": "string", "enum": ["return", "level"] }
      },
      "required": ["kind", "seriesA", "seriesB"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "const": "unsupported" },
        "reason": { "type": "string" }
      },
      "required": ["kind"],
      "additionalProperties": false
    }
  ]
}`)

var assistantQueryPlanResponseFormat = json.RawMessage(`{
  "type": "json_schema",
  "json_schema": {
    "name": "assistant_query_plan",
    "schema": ` + string(assistantQueryPlanSchema) + `
  }
}`)

var correlationFieldSelectionResponseFormat = json.RawMessage(`{
  "type": "json_schema",
  "json_schema": {
    "name": "assistant_correlation_field_selection",
    "schema": {
      "type": "object",
      "properties": {
        "fieldA": { "type": "string", "minLength": 1 },
        "fieldB": { "type": "string", "minLength": 1 }
      },
      "required": ["fieldA", "fieldB"],
      "additionalProperties": false
    }
  }
}`)

var correlationSeriesSelectionResponseFormat = json.RawMessage(`{
  "type": "json_schema",
  "json_schema": {
    "name": "assistant_correlation_series_selection",
    "schema": {
      "type": "object",
      "properties": {
        "slugA": { "type": "string", "minLength": 1 },
        "slugB": { "type": "string", "minLength": 1 }
      },
      "required": ["slugA", "slugB"],
      "additionalProperties": false
    }
  }
}`)

// buildQueryPlannerRequest ports buildQueryPlannerRequest.
func buildQueryPlannerRequest(message string) ([]publicportal.AssistantMessage, json.RawMessage) {
	system := joinLines(
		"You are a planner for a finance analysis assistant.",
		"Your job: classify the user request into one supported plan and extract parameters.",
		"Return ONLY valid JSON matching the provided schema.",
		"",
		"Supported kinds:",
		"- news_negative_list: list negative news about a topic for a recent time window.",
		"- correlation_two_series: analyze correlation between any two economic indicators.",
		"",
		"Rules:",
		"- If the user asks for negative news, use news_negative_list and extract the topic.",
		"- If the user asks about correlation between two indicators, use correlation_two_series and extract the two indicators.",
		"- Indicators can be natural language names (e.g., 'gold price', 'USD index') or explicit slugs (e.g., 'usd_index_history').",
		"- Otherwise, use unsupported.",
	)
	user := joinLines("User request:", message)
	return []publicportal.AssistantMessage{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}, assistantQueryPlanResponseFormat
}

// correlationSeriesCandidate is one selector candidate.
type correlationSeriesCandidate struct {
	Slug        string  `json:"slug"`
	DisplayName string  `json:"displayName"`
	Description *string `json:"description"`
}

type correlationSeriesSelectorInput struct {
	Question string `json:"question"`
	SeriesA  struct {
		Query      string                       `json:"query"`
		Candidates []correlationSeriesCandidate `json:"candidates"`
	} `json:"seriesA"`
	SeriesB struct {
		Query      string                       `json:"query"`
		Candidates []correlationSeriesCandidate `json:"candidates"`
	} `json:"seriesB"`
}

// buildCorrelationSeriesSelectorRequest ports
// buildCorrelationSeriesSelectorRequest.
func buildCorrelationSeriesSelectorRequest(input correlationSeriesSelectorInput) ([]publicportal.AssistantMessage, json.RawMessage) {
	system := joinLines(
		"You are selecting the best economic time series slug for correlation analysis.",
		"Pick EXACTLY one slug for each series (slugA and slugB) from the provided candidates.",
		"Return ONLY valid JSON matching the schema.",
		"",
		"Guidance:",
		"- Prefer the candidate that best matches the user's wording and intent.",
		"- Prefer widely-used headline series over niche variants when ambiguous.",
	)
	payload, _ := json.Marshal(input)
	user := joinLines("Candidates (JSON):", string(payload))
	return []publicportal.AssistantMessage{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}, correlationSeriesSelectionResponseFormat
}

type correlationFieldCandidate struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type correlationFieldSelectorSeries struct {
	Slug        string                      `json:"slug"`
	DisplayName *string                     `json:"displayName"`
	Fields      []correlationFieldCandidate `json:"fields"`
}

type correlationFieldSelectorInput struct {
	SeriesA correlationFieldSelectorSeries `json:"seriesA"`
	SeriesB correlationFieldSelectorSeries `json:"seriesB"`
}

// buildCorrelationFieldSelectorRequest ports
// buildCorrelationFieldSelectorRequest.
func buildCorrelationFieldSelectorRequest(input correlationFieldSelectorInput) ([]publicportal.AssistantMessage, json.RawMessage) {
	system := joinLines(
		"You are selecting the best sourceField for two economic time series.",
		"Pick one field for each series from the provided candidates.",
		"Return ONLY valid JSON matching the schema.",
		"",
		"Guidance:",
		"- Prefer the primary level series (e.g., close/last) over open/high/low/change percent.",
		"- Prefer fields with higher sample counts.",
	)
	payload, _ := json.Marshal(input)
	user := joinLines("Candidate fields (JSON):", string(payload))
	return []publicportal.AssistantMessage{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}, correlationFieldSelectionResponseFormat
}

type newsListRendererInput struct {
	Question  string
	StartDate string
	EndDate   string
	Items     []RenderedItem
}

// buildNewsListRendererMessages ports buildNewsListRendererMessages.
func buildNewsListRendererMessages(input newsListRendererInput) []publicportal.AssistantMessage {
	system := joinLines(
		"You are a finance news analyst.",
		"Write the response in Simplified Chinese.",
		"Only use the provided items; do not invent facts or URLs.",
		"Keep the output concise and actionable.",
	)
	payload, _ := json.Marshal(input.Items)
	user := joinLines(
		"Question: "+input.Question,
		"Time window: "+input.StartDate+" to "+input.EndDate,
		"Items (JSON):",
		string(payload),
	)
	return []publicportal.AssistantMessage{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}
}

type correlationRendererSeries struct {
	Slug        string  `json:"slug"`
	DisplayName *string `json:"displayName"`
	Field       string  `json:"field"`
	DocURL      *string `json:"docUrl"`
}

type correlationRendererInput struct {
	Question  string
	StartDate string
	EndDate   string
	SeriesA   correlationRendererSeries
	SeriesB   correlationRendererSeries
	Stats     CorrelationStats
	Refs      []LabeledReference
}

// LabeledReference is one {label,value} reference of the correlation renderer.
type LabeledReference struct {
	Label string `json:"label" bson:"label"`
	Value string `json:"value" bson:"value"`
}

// buildCorrelationRendererMessages ports buildCorrelationRendererMessages.
func buildCorrelationRendererMessages(input correlationRendererInput) []publicportal.AssistantMessage {
	system := joinLines(
		"You are a quantitative finance analyst.",
		"Write the response in Simplified Chinese.",
		"Explain the correlation result and key caveats.",
		"Do not claim causality.",
		"Only use the provided statistics and metadata; do not invent numbers.",
	)
	payload, _ := json.Marshal(struct {
		Question   string                    `json:"question"`
		TimeWindow TimeWindow                `json:"timeWindow"`
		SeriesA    correlationRendererSeries `json:"seriesA"`
		SeriesB    correlationRendererSeries `json:"seriesB"`
		Stats      CorrelationStats          `json:"stats"`
		References []LabeledReference        `json:"references"`
	}{
		Question:   input.Question,
		TimeWindow: TimeWindow{StartDate: input.StartDate, EndDate: input.EndDate},
		SeriesA:    input.SeriesA,
		SeriesB:    input.SeriesB,
		Stats:      input.Stats,
		References: input.Refs,
	})
	user := joinLines("Input (JSON):", string(payload))
	return []publicportal.AssistantMessage{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}
}

func joinLines(lines ...string) string {
	out := ""
	for index, line := range lines {
		if index > 0 {
			out += "\n"
		}
		out += line
	}
	return out
}
