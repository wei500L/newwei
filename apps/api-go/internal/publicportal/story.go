package publicportal

import (
	"context"
	"log"
	"strings"
	"time"
)

// StoryDetailResponse 是两个故事详情 GET 的共同响应。
type StoryDetailResponse struct {
	GeneratedAt    string      `json:"generatedAt"`
	Org            Org         `json:"org"`
	Story          StoryDetail `json:"story"`
	RelatedStories []Story     `json:"relatedStories"`
}

// StoryDetail 在故事卡上附加 brief、时间线和引用文章。
type StoryDetail struct {
	Story
	Brief              *briefView     `json:"brief"`
	Timeline           []timelineView `json:"timeline"`
	ReferencedArticles []articleView  `json:"referencedArticles"`
}

type timelineView struct {
	ID          string  `json:"id"`
	BucketStart string  `json:"bucketStart"`
	Title       *string `json:"title"`
	Summary     *string `json:"summary"`
}

type articleView struct {
	ID          string  `json:"id"`
	URL         string  `json:"url"`
	SourceLabel *string `json:"sourceLabel"`
	Title       *string `json:"title"`
	PublishedAt *string `json:"publishedAt"`
}

// Story 按 id 或 slug 返回同一份详情。找不到合格公开故事时返回 nil。
// brief 冷路径失败时返回 error，调用方必须回 500/503，不能返回缺 brief 的 200。
func (s *Service) Story(ctx context.Context, raw string) (*StoryDetailResponse, error) {
	eventID := extractStoryID(raw)
	if eventID == "" {
		return nil, nil
	}
	org, err := s.store.PublicOrg(ctx)
	if err != nil {
		return nil, err
	}
	if org == nil {
		return nil, nil
	}
	event, err := s.store.LoadEvent(ctx, org.ID, eventID)
	if err != nil {
		return nil, err
	}
	if event == nil || event.OrgID != org.ID || event.Status != "active" || event.Title == "" || event.Summary == "" {
		return nil, nil
	}

	now := s.now()
	policy, err := s.store.SourcePolicy(ctx, org.ID)
	if err != nil {
		log.Printf("public portal source policy unavailable; using default")
		policy = defaultMatcher()
	}
	counts, err := s.store.ItemCounts(ctx, org.ID, []string{event.ID})
	if err != nil {
		return nil, err
	}
	heatItems, err := s.store.HeatItems(ctx, org.ID, []string{event.ID}, now.Add(-4*time.Hour))
	if err != nil {
		return nil, err
	}
	authorityItems, err := s.store.AuthorityItems(ctx, org.ID, []string{event.ID}, now.Add(-authorityWindowDay*24*time.Hour))
	if err != nil {
		return nil, err
	}
	heat := heatByEvent(now, now.Add(-time.Hour), []EventRow{event.EventRow}, heatItems)
	authority := authorityByEvent(policy, []string{event.ID}, authorityItems)
	card := toStory(event.EventRow, counts[event.ID], heat[event.ID], authority[event.ID])
	if card == nil {
		return nil, nil
	}

	windowDays := s.store.TimelineWindowDays(ctx, org.ID)
	entries, err := s.store.Timeline(ctx, org.ID, event.ID, now.Add(-time.Duration(windowDays)*24*time.Hour))
	if err != nil {
		return nil, err
	}
	items, err := s.store.BriefItems(ctx, org.ID, event.ID, briefItemLimit)
	if err != nil {
		return nil, err
	}
	referencedIDs := make([]string, 0)
	for _, entry := range entries {
		referencedIDs = append(referencedIDs, entry.ReferencedArticleIDs...)
	}
	referencedIDs = uniqueNonEmpty(referencedIDs)
	if len(referencedIDs) == 0 {
		limit := fallbackItems
		if len(items) < limit {
			limit = len(items)
		}
		for _, item := range items[:limit] {
			if item.ArticleID != "" {
				referencedIDs = append(referencedIDs, item.ArticleID)
			}
		}
		referencedIDs = uniqueNonEmpty(referencedIDs)
	}
	articles, err := s.store.ReferencedArticles(ctx, org.ID, event.ID, referencedIDs, 12)
	if err != nil {
		return nil, err
	}
	brief, err := s.brief(ctx, org.ID, event, items)
	if err != nil {
		return nil, err
	}
	related, err := s.list(ctx, org.ID, 4, card.TopicSlug, card.ID)
	if err != nil {
		return nil, err
	}
	if related == nil {
		related = []Story{}
	}

	timeline := make([]timelineView, 0, len(entries))
	for _, entry := range entries {
		timeline = append(timeline, timelineView{
			ID:          entry.ID,
			BucketStart: isoTime(entry.BucketStart),
			Title:       optionalString(entry.Title),
			Summary:     optionalString(entry.Summary),
		})
	}
	articleViews := make([]articleView, 0, len(articles))
	for _, article := range articles {
		view := articleView{
			ID:          article.ID,
			URL:         article.URL,
			SourceLabel: optionalString(article.SourceLabel),
			Title:       optionalString(article.Title),
		}
		if article.HasPublished {
			text := isoTime(article.PublishedAt)
			view.PublishedAt = &text
		}
		articleViews = append(articleViews, view)
	}
	return &StoryDetailResponse{
		GeneratedAt: isoTime(now),
		Org:         *org,
		Story: StoryDetail{
			Story:              *card,
			Brief:              brief,
			Timeline:           timeline,
			ReferencedArticles: articleViews,
		},
		RelatedStories: related,
	}, nil
}

func (s *Service) brief(ctx context.Context, orgID string, event *EventDetail, items []BriefItem) (*briefView, error) {
	sources := selectBriefSources(items, briefMaxSources)
	if len(sources) == 0 {
		return nil, nil
	}
	language := normalizeBriefLanguage(event.Language)
	fingerprint := briefFingerprint(language, isoTime(event.LastAt), sources)
	if cached := readCachedBrief(event.Metadata, language, fingerprint, s.now()); cached != nil {
		return cached, nil
	}
	title := strings.TrimSpace(event.Title)
	if title == "" {
		title = strings.TrimSpace(event.PrimaryEntity)
	}
	if title == "" {
		title = strings.TrimSpace(event.PrimaryTopic)
	}
	if title == "" {
		title = event.ID
	}
	content, err := s.completer().Complete(ctx, completionRequest{
		OrgID:  orgID,
		System: buildBriefSystemPrompt(language),
		User:   buildBriefUserPrompt(title, event.Summary, event.Language, event.StartAt, event.LastAt, sources),
		Metadata: map[string]any{
			"feature":    "news_event_brief",
			"eventTitle": title,
			"sources":    len(sources),
		},
	})
	if err != nil {
		return nil, err
	}
	parsed, ok := parseBriefJSON(content)
	if !ok {
		return nil, errInvalidBrief
	}
	sanitized, ok := sanitizeBriefPayload(parsed, len(sources))
	if !ok {
		return nil, errInvalidBrief
	}
	generatedAt := s.now().UTC()
	view := &briefView{
		GeneratedAt: isoTime(generatedAt),
		Language:    language,
		Payload:     sanitized,
		Sources:     viewsFromSources(sources),
	}
	document := map[string]any{
		"version":     briefVersion,
		"language":    language,
		"fingerprint": fingerprint,
		"generatedAt": view.GeneratedAt,
		"sources":     cacheSources(sources),
		"payload":     sanitized,
	}
	merged, err := mergeBriefMetadata(event.Metadata, document)
	if err != nil {
		log.Printf("public portal brief cache merge failed")
		return view, nil
	}
	if err := s.store.SaveEventMetadata(ctx, orgID, event.ID, merged); err != nil {
		log.Printf("public portal brief cache write failed")
	}
	return view, nil
}

var errInvalidBrief = errString("model gateway returned an invalid brief")

type errString string

func (e errString) Error() string { return string(e) }

func cacheSources(sources []briefSource) []any {
	out := make([]any, 0, len(sources))
	for _, source := range sources {
		var published any
		if source.PublishedAt != nil {
			published = isoTime(*source.PublishedAt)
		}
		out = append(out, map[string]any{
			"index":              source.Index,
			"url":                source.URL,
			"sourceLabel":        emptyAsNil(source.SourceLabel),
			"title":              emptyAsNil(source.Title),
			"publishedAt":        published,
			"processedItemId":    emptyAsNil(source.ProcessedItemID),
			"processedArticleId": emptyAsNil(source.ProcessedArticleID),
		})
	}
	return out
}

func emptyAsNil(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}
