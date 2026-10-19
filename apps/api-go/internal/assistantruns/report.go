package assistantruns

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// runReport ports runReport: list the window's items, render them, count
// sentiments and stream a structured Chinese report.
func (s *Service) runReport(ctx context.Context, record *runRecord, createdAt time.Time, input ReportInput, guardrails []string, assistantModel string) (bson.Raw, string, error) {
	period := "daily"
	if input.Period == "weekly" {
		period = "weekly"
	}
	lookbackDays := 1
	if period == "weekly" {
		lookbackDays = 7
	}
	limit := 40
	if input.Limit != nil {
		limit = clampInt(*input.Limit, 1, 100)
	}
	topic := ""
	if input.Topic != nil {
		topic = strings.TrimSpace(*input.Topic)
	}
	end := time.Now().UTC()
	start := end.Add(-time.Duration(lookbackDays) * 24 * time.Hour)

	query := itemsreading.ItemsListQuery{
		First:       limit,
		Page:        intPtr(1),
		Filters:     &itemsreading.ItemFilters{DateRange: &itemsreading.ItemDateRangeFilter{Start: &start, End: &end}},
		OrderBy:     itemsreading.ItemsListOrderPublishedDesc,
		RankingMode: itemsreading.ItemsRankingRecency,
	}
	if topic != "" {
		query.Search = &topic
	}
	page, err := s.items.ListItems(ctx, record.OrgID, "", query)
	if err != nil {
		return nil, "", err
	}
	rendered, err := s.store.RenderNewsItems(ctx, record.OrgID, newsRows(page))
	if err != nil {
		return nil, "", err
	}
	counts, order := sentimentCounts(rendered)
	statsJSON, err := marshalOrderedStats(counts, order)
	if err != nil {
		return nil, "", err
	}
	itemsJSON, err := json.Marshal(rendered)
	if err != nil {
		return nil, "", err
	}
	topicLine := "Topic filter: (none)"
	if topic != "" {
		topicLine = "Topic filter: " + topic
	}
	messages := []publicportal.AssistantMessage{
		{Role: "system", Content: joinLines(
			"You are a finance market analyst.",
			"Write the report in Simplified Chinese.",
			"Only use the provided items; do not invent facts, tickers, or URLs.",
			"Keep the output concise and structured.",
		)},
		{Role: "user", Content: joinLines(
			"Report period: "+period,
			"Time window: "+start.Format("2006-01-02")+" to "+end.Format("2006-01-02"),
			topicLine,
			"Sentiment counts (JSON):",
			statsJSON,
			"Items (JSON):",
			string(itemsJSON),
		)},
	}
	summary, raw, err := s.streamMessages(ctx, record, createdAt, RunTypeReport, messages, streamOptions{
		Guardrails:     guardrails,
		AssistantModel: assistantModel,
	})
	if err != nil {
		return nil, "", err
	}
	var storedTopic *string
	if topic != "" {
		storedTopic = &topic
	}
	marshaled, err := bson.Marshal(ReportOutput{
		Period:     period,
		Topic:      storedTopic,
		TimeWindow: TimeWindow{StartDate: start.Format("2006-01-02"), EndDate: end.Format("2006-01-02")},
		Stats:      counts,
		Items:      rendered,
		Summary:    summary,
		Raw:        raw,
	})
	return bson.Raw(marshaled), summary, err
}

// sentimentCounts ports the report reduce and remembers first-appearance order
// so the prompt JSON matches JSON.stringify's insertion order.
func sentimentCounts(items []RenderedItem) (SentimentCounts, []string) {
	counts := SentimentCounts{}
	order := make([]string, 0, 4)
	for _, item := range items {
		key := "unknown"
		if item.Sentiment != nil && *item.Sentiment != "" {
			key = *item.Sentiment
		}
		if _, exists := counts[key]; !exists {
			order = append(order, key)
		}
		counts[key]++
	}
	return counts, order
}

// marshalOrderedStats renders the stats object in insertion order. Go map
// marshaling sorts keys, which would change the model prompt.
func marshalOrderedStats(counts SentimentCounts, order []string) (string, error) {
	var builder strings.Builder
	builder.WriteByte('{')
	for index, key := range order {
		if index > 0 {
			builder.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return "", err
		}
		builder.Write(encodedKey)
		builder.WriteByte(':')
		builder.WriteString(fmt.Sprintf("%d", counts[key]))
	}
	builder.WriteByte('}')
	return builder.String(), nil
}
