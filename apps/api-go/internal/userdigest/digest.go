package userdigest

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"
)

// Digest 是 UserDigestV1。windowEnd 是今天 UTC 00:00，事件查询不再加 lastAt 上界。
type Digest struct {
	Version     int        `json:"version"`
	GeneratedAt string     `json:"generatedAt"`
	WindowStart string     `json:"windowStart"`
	WindowEnd   string     `json:"windowEnd"`
	Preference  Preference `json:"preference"`
	Events      []Event    `json:"events"`
}

// Event 是一条摘要事件。indicatorAssociations 为空时省略，情绪字段始终在（可为 null）。
type Event struct {
	EventID               string                 `json:"eventId"`
	Title                 *string                `json:"title"`
	Summary               *string                `json:"summary"`
	PrimaryTopic          *string                `json:"primaryTopic"`
	PrimaryEntity         *string                `json:"primaryEntity"`
	StartAt               string                 `json:"startAt"`
	LastAt                string                 `json:"lastAt"`
	ItemCount             int                    `json:"itemCount"`
	RepresentativeURL     *string                `json:"representativeUrl"`
	TopicSentiment        *Sentiment             `json:"topicSentiment"`
	EntitySentiment       *Sentiment             `json:"entitySentiment"`
	IndicatorAssociations []IndicatorAssociation `json:"indicatorAssociations,omitempty"`
}

func (s *Service) GenerateDigest(ctx context.Context, orgID, userID string) (Digest, error) {
	preference, err := s.GetPreference(ctx, orgID, userID)
	if err != nil {
		return Digest{}, err
	}
	subs, err := s.subscriptionValues(ctx, orgID, userID)
	if err != nil {
		return Digest{}, err
	}
	now := s.clock().UTC()
	windowEnd := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	windowStart := windowEnd.Add(-time.Duration(preference.WindowDays) * 24 * time.Hour)
	rows, err := s.loadEvents(ctx, orgID, preference, subs, windowStart)
	if err != nil {
		return Digest{}, err
	}
	topics := uniqueTrimmed(rows, func(event digestEvent) *string { return event.PrimaryTopic })
	entities := uniqueTrimmed(rows, func(event digestEvent) *string { return event.PrimaryEntity })
	topicSentiment, err := s.loadTopicSentiments(ctx, orgID, topics)
	if err != nil {
		return Digest{}, err
	}
	entitySentiment, err := s.loadEntitySentiments(ctx, orgID, entities)
	if err != nil {
		return Digest{}, err
	}
	var indicators map[string][]IndicatorAssociation
	if preference.IncludeIndicators && preference.MaxIndicatorsPerEvent > 0 {
		indicators, err = s.loadIndicators(ctx, orgID, rows, preference.MaxIndicatorsPerEvent)
		if err != nil {
			return Digest{}, err
		}
	}
	events := make([]Event, 0, len(rows))
	for _, row := range rows {
		events = append(events, enrichEvent(row, preference, topicSentiment, entitySentiment, indicators))
	}
	return Digest{
		Version:     1,
		GeneratedAt: isoTime(s.clock()),
		WindowStart: isoTime(windowStart),
		WindowEnd:   isoTime(windowEnd),
		Preference:  preference,
		Events:      events,
	}, nil
}

func enrichEvent(event digestEvent, preference Preference, topics, entities map[string]Sentiment, indicators map[string][]IndicatorAssociation) Event {
	var topicSentiment *Sentiment
	if event.PrimaryTopic != nil && *event.PrimaryTopic != "" {
		if sentiment, ok := topics[*event.PrimaryTopic]; ok {
			copied := sentiment
			topicSentiment = &copied
		}
	}
	var entitySentiment *Sentiment
	if event.PrimaryEntity != nil && *event.PrimaryEntity != "" {
		if sentiment, ok := entities[*event.PrimaryEntity]; ok {
			copied := sentiment
			entitySentiment = &copied
		}
	}
	out := Event{
		EventID:           event.ID,
		Title:             event.Title,
		Summary:           event.Summary,
		PrimaryTopic:      event.PrimaryTopic,
		PrimaryEntity:     event.PrimaryEntity,
		StartAt:           isoTime(event.StartAt),
		LastAt:            isoTime(event.LastAt),
		ItemCount:         event.ItemCount,
		RepresentativeURL: event.RepresentativeURL,
		TopicSentiment:    topicSentiment,
		EntitySentiment:   entitySentiment,
	}
	if !preference.IncludeIndicators {
		return out
	}
	limit := preference.MaxIndicatorsPerEvent
	if limit < 1 {
		limit = 1
	}
	if limit > 50 {
		limit = 50
	}
	var associations []IndicatorAssociation
	if event.PrimaryTopic != nil && *event.PrimaryTopic != "" {
		associations = append(associations, indicators["topic:"+*event.PrimaryTopic]...)
	}
	if event.PrimaryEntity != nil && *event.PrimaryEntity != "" {
		associations = append(associations, indicators["entity:"+*event.PrimaryEntity]...)
	}
	if len(associations) == 0 {
		return out
	}
	// 拷贝后再排序，避免改到按 scope 缓存的切片。
	copied := append([]IndicatorAssociation(nil), associations...)
	sortByAbsCorrelation(copied)
	if len(copied) > limit {
		copied = copied[:limit]
	}
	out.IndicatorAssociations = copied
	return out
}

func sortByAbsCorrelation(entries []IndicatorAssociation) {
	sort.SliceStable(entries, func(i, j int) bool {
		return math.Abs(entries[i].Correlation) > math.Abs(entries[j].Correlation)
	})
}

func uniqueTrimmed(events []digestEvent, pick func(digestEvent) *string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0)
	for _, event := range events {
		value := pick(event)
		if value == nil {
			continue
		}
		trimmed := strings.TrimSpace(*value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}
