package publicportal

import (
	"context"
	"log"
	"strings"
	"time"
)

const (
	homeLimit          = 12
	channelLimit       = 18
	maxStoryPages      = 30
	minItemCount       = 2
	minCredibility     = 60
	authorityWindowDay = 45
)

// Story 是首页与频道共用的故事卡片。
type Story struct {
	ID               string         `json:"id"`
	Slug             string         `json:"slug"`
	Title            string         `json:"title"`
	Summary          string         `json:"summary"`
	Topic            string         `json:"topic"`
	TopicSlug        string         `json:"topicSlug"`
	PrimaryEntity    *string        `json:"primaryEntity"`
	Language         *string        `json:"language"`
	LastAt           string         `json:"lastAt"`
	StartAt          string         `json:"startAt"`
	ItemCount        int            `json:"itemCount"`
	Breaking         bool           `json:"breaking"`
	HeatScore        float64        `json:"heatScore"`
	CredibilityScore float64        `json:"credibilityScore"`
	SourceType       string         `json:"sourceType"`
	SourceEvidence   SourceEvidence `json:"sourceEvidence"`
}

// SourceEvidence 对齐 Nest sourceEvidence 字段。
type SourceEvidence struct {
	UniqueSourceCount        int  `json:"uniqueSourceCount"`
	AuthoritativeSourceCount int  `json:"authoritativeSourceCount"`
	BlogSourceCount          int  `json:"blogSourceCount"`
	Corroborated             bool `json:"corroborated"`
}

// TopicSummary 是首页频道汇总。
type TopicSummary struct {
	Topic      string `json:"topic"`
	TopicSlug  string `json:"topicSlug"`
	StoryCount int    `json:"storyCount"`
	LatestAt   string `json:"latestAt"`
}

// HomeResponse 是 GET /api/public-portal/home。
type HomeResponse struct {
	GeneratedAt   string         `json:"generatedAt"`
	Org           *Org           `json:"org"`
	FeaturedStory *Story         `json:"featuredStory"`
	LatestStories []Story        `json:"latestStories"`
	Channels      []TopicSummary `json:"channels"`
}

// ChannelResponse 是 GET /api/public-portal/channels/:topic。
// 未配置公开组织时服务返回 nil，由 handler 回 404。
type ChannelResponse struct {
	GeneratedAt string  `json:"generatedAt"`
	Org         Org     `json:"org"`
	Topic       string  `json:"topic"`
	TopicSlug   string  `json:"topicSlug"`
	StoryCount  int     `json:"storyCount"`
	Stories     []Story `json:"stories"`
}

// Completer 调用已配置的模型网关。测试可替换；生产实现读取
// SystemSetting 里的 gateway profile，不把请求转给 NestJS。
type Completer interface {
	Complete(ctx context.Context, req completionRequest) (string, error)
}

// Service 组装公开首页、频道和故事详情。不读取请求里的租户参数。
type Service struct {
	store      Store
	now        func() time.Time
	complete   Completer
	gatewayEnv GatewayEnv
}

func NewService(store Store) *Service {
	return &Service{store: store, now: time.Now}
}

func (s *Service) UseGateway(env GatewayEnv) {
	s.gatewayEnv = env
}

func (s *Service) completer() Completer {
	if s.complete != nil {
		return s.complete
	}
	return newGateway(s.store, s.gatewayEnv)
}

func (s *Service) Home(ctx context.Context) (HomeResponse, error) {
	org, err := s.store.PublicOrg(ctx)
	if err != nil {
		return HomeResponse{}, err
	}
	if org == nil {
		return HomeResponse{
			GeneratedAt:   isoTime(s.now()),
			LatestStories: []Story{},
			Channels:      []TopicSummary{},
		}, nil
	}
	stories, err := s.list(ctx, org.ID, homeLimit, "", "")
	if err != nil {
		return HomeResponse{}, err
	}
	var featured *Story
	latest := []Story{}
	if len(stories) > 0 {
		featured = &stories[0]
		if len(stories) > 1 {
			latest = stories[1:]
		}
	}
	return HomeResponse{
		GeneratedAt:   isoTime(s.now()),
		Org:           org,
		FeaturedStory: featured,
		LatestStories: latest,
		Channels:      topicSummaries(stories),
	}, nil
}

func (s *Service) Channel(ctx context.Context, topic string) (*ChannelResponse, error) {
	org, err := s.store.PublicOrg(ctx)
	if err != nil {
		return nil, err
	}
	if org == nil {
		return nil, nil
	}
	topicSlug := sanitizeSlugSegment(topic)
	stories, err := s.list(ctx, org.ID, channelLimit, topicSlug, "")
	if err != nil {
		return nil, err
	}
	label := topicFallback
	if len(stories) > 0 {
		label = stories[0].Topic
	} else {
		label = channelTopicLabel(topic)
	}
	if stories == nil {
		stories = []Story{}
	}
	return &ChannelResponse{
		GeneratedAt: isoTime(s.now()),
		Org:         *org,
		Topic:       label,
		TopicSlug:   topicSlug,
		StoryCount:  len(stories),
		Stories:     stories,
	}, nil
}

func (s *Service) list(ctx context.Context, orgID string, limit int, topicSlug, excludeEventID string) ([]Story, error) {
	stories := make([]Story, 0, limit)
	var cursor *PageCursor
	now := s.now()
	authoritySince := now.Add(-authorityWindowDay * 24 * time.Hour)
	heatSince := now.Add(-4 * time.Hour)
	oneHourAgo := now.Add(-time.Hour)

	policy, err := s.store.SourcePolicy(ctx, orgID)
	if err != nil {
		// 策略读失败回落默认名单。不把数据库错误带回响应或日志。
		log.Printf("public portal source policy unavailable; using default")
		policy = defaultMatcher()
	}

	for page := 0; page < maxStoryPages && len(stories) < limit; page++ {
		rows, err := s.store.ListEventPage(ctx, orgID, cursor, excludeEventID)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			break
		}
		last := rows[len(rows)-1]
		cursor = &PageCursor{LastAt: last.LastAt, StartAt: last.StartAt, ID: last.ID}

		kept := make([]EventRow, 0, len(rows))
		ids := make([]string, 0, len(rows))
		for _, row := range rows {
			// SQL 已限制 orgId 与 active。这里再拒一次，避免仓储实现
			// 把其他组织或归档行送进公开响应。
			if row.OrgID != orgID || row.Status != "active" || row.ID == excludeEventID {
				continue
			}
			kept = append(kept, row)
			ids = append(ids, row.ID)
		}

		counts, err := s.store.ItemCounts(ctx, orgID, ids)
		if err != nil {
			return nil, err
		}
		heatItems, err := s.store.HeatItems(ctx, orgID, ids, heatSince)
		if err != nil {
			return nil, err
		}
		authorityItems, err := s.store.AuthorityItems(ctx, orgID, ids, authoritySince)
		if err != nil {
			return nil, err
		}
		heatByID := heatByEvent(now, oneHourAgo, kept, heatItems)
		authorityByID := authorityByEvent(policy, ids, authorityItems)

		for _, row := range kept {
			card := toStory(row, counts[row.ID], heatByID[row.ID], authorityByID[row.ID])
			if card == nil {
				continue
			}
			if topicSlug != "" && card.TopicSlug != topicSlug {
				continue
			}
			stories = append(stories, *card)
		}
		if len(rows) < pageSize {
			break
		}
	}
	if len(stories) > limit {
		stories = stories[:limit]
	}
	return stories, nil
}

func heatByEvent(now, oneHourAgo time.Time, rows []EventRow, items []HeatItem) map[string]heatProfile {
	lastAt := make(map[string]time.Time, len(rows))
	type agg struct {
		last1h  int
		last4h  int
		sources map[string]struct{}
	}
	byID := make(map[string]*agg, len(rows))
	for _, row := range rows {
		lastAt[row.ID] = row.LastAt
		byID[row.ID] = &agg{sources: map[string]struct{}{}}
	}
	for _, item := range items {
		bucket := byID[item.EventID]
		if bucket == nil {
			continue
		}
		bucket.last4h++
		if !item.CreatedAt.Before(oneHourAgo) {
			bucket.last1h++
		}
		if item.SourceID != "" {
			bucket.sources[item.SourceID] = struct{}{}
		}
	}
	out := make(map[string]heatProfile, len(rows))
	for id, bucket := range byID {
		out[id] = heatFrom(now, lastAt[id], bucket.last1h, bucket.last4h, len(bucket.sources))
	}
	return out
}

func authorityByEvent(policy matcher, ids []string, items []AuthorityItem) map[string]authorityProfile {
	type agg struct {
		keys          map[string]struct{}
		authoritative map[string]struct{}
		blog          map[string]struct{}
		authItems     int
		blogItems     int
		total         int
	}
	byID := make(map[string]*agg, len(ids))
	for _, id := range ids {
		byID[id] = &agg{
			keys:          map[string]struct{}{},
			authoritative: map[string]struct{}{},
			blog:          map[string]struct{}{},
		}
	}
	for _, item := range items {
		bucket := byID[item.EventID]
		if bucket == nil {
			continue
		}
		sourceKey := strings.ToLower(resolveSourceKey(item.SourceLabel, item.URL))
		if sourceKey != "" && sourceKey != "unknown" {
			bucket.keys[sourceKey] = struct{}{}
		}
		classified := classifySource(item.SourceLabel, item.URL, policy)
		bucket.total++
		switch classified {
		case "authoritative":
			bucket.authItems++
			if sourceKey != "" && sourceKey != "unknown" {
				bucket.authoritative[sourceKey] = struct{}{}
			}
		case "blog":
			bucket.blogItems++
			if sourceKey != "" && sourceKey != "unknown" {
				bucket.blog[sourceKey] = struct{}{}
			}
		}
	}
	out := make(map[string]authorityProfile, len(ids))
	for id, bucket := range byID {
		out[id] = authorityFromAggregates(
			len(bucket.keys),
			len(bucket.authoritative),
			len(bucket.blog),
			bucket.authItems,
			bucket.blogItems,
			bucket.total,
		)
	}
	return out
}

func toStory(row EventRow, itemCount int, heat heatProfile, authority authorityProfile) *Story {
	title := strings.TrimSpace(row.Title)
	summary := strings.TrimSpace(row.Summary)
	if title == "" || summary == "" {
		return nil
	}
	if itemCount < minItemCount {
		return nil
	}
	if authority.SourceType != "authoritative" && authority.SourceType != "mixed" {
		return nil
	}
	if authority.CredibilityScore < minCredibility {
		return nil
	}
	topic := strings.TrimSpace(row.PrimaryTopic)
	if topic == "" {
		topic = strings.TrimSpace(row.PrimaryEntity)
	}
	if topic == "" {
		topic = topicFallback
	}
	return &Story{
		ID:               row.ID,
		Slug:             buildStorySlug(row.ID, title),
		Title:            title,
		Summary:          summary,
		Topic:            topic,
		TopicSlug:        sanitizeSlugSegment(topic),
		PrimaryEntity:    optionalString(row.PrimaryEntity),
		Language:         optionalString(row.Language),
		LastAt:           isoTime(row.LastAt),
		StartAt:          isoTime(row.StartAt),
		ItemCount:        itemCount,
		Breaking:         heat.Breaking,
		HeatScore:        heat.HeatScore,
		CredibilityScore: authority.CredibilityScore,
		SourceType:       authority.SourceType,
		SourceEvidence: SourceEvidence{
			UniqueSourceCount:        authority.UniqueSourceCount,
			AuthoritativeSourceCount: authority.AuthoritativeSourceCount,
			BlogSourceCount:          authority.BlogSourceCount,
			Corroborated:             authority.Corroborated,
		},
	}
}

func optionalString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func topicSummaries(stories []Story) []TopicSummary {
	order := make([]string, 0)
	bySlug := map[string]*TopicSummary{}
	for _, story := range stories {
		existing := bySlug[story.TopicSlug]
		if existing != nil {
			existing.StoryCount++
			if story.LastAt > existing.LatestAt {
				existing.LatestAt = story.LastAt
			}
			continue
		}
		summary := &TopicSummary{
			Topic:      story.Topic,
			TopicSlug:  story.TopicSlug,
			StoryCount: 1,
			LatestAt:   story.LastAt,
		}
		bySlug[story.TopicSlug] = summary
		order = append(order, story.TopicSlug)
	}
	out := make([]TopicSummary, 0, len(order))
	for _, slug := range order {
		out = append(out, *bySlug[slug])
	}
	// 稳定排序：latestAt 降序，相同时间保持首次出现顺序。
	for i := 1; i < len(out); i++ {
		current := out[i]
		j := i
		for j > 0 && out[j-1].LatestAt < current.LatestAt {
			out[j] = out[j-1]
			j--
		}
		out[j] = current
	}
	return out
}

func isoTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
