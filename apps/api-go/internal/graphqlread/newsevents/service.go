package newsevents

import (
	"context"
	"database/sql"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

const dedupeWindow = 5 * 24 * time.Hour

var (
	tokenSplit = regexp.MustCompile(`[^a-z0-9\x{4e00}-\x{9fff}]+`)
	hanRune    = regexp.MustCompile(`[\x{4e00}-\x{9fff}]`)
)

type service struct {
	db    *sql.DB
	mongo *mongo.Database
	redis *redis.Client
	now   func() time.Time
}

func (s *service) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *service) call(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
}

func (s *service) newsEvents(ctx contract.Context) (any, error) {
	if s == nil || s.db == nil {
		return nil, &contract.Failure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
	requested := optionalInt(ctx.Args, "limit", 20, 1, 100)
	candidate := requested * 4
	if candidate < requested {
		candidate = requested
	}
	if candidate > 300 {
		candidate = 300
	}
	windowDays := optionalInt(ctx.Args, "windowDays", 30, 1, 365)
	status, _ := contract.StringArg(ctx.Args, "status")
	entity, _ := contract.StringArg(ctx.Args, "entity")
	entity = clipUTF16(strings.TrimSpace(entity), 120)
	rows, err := s.listEventRows(s.call(ctx), ctx.Identity.OrgID, candidate, windowDays, status, entity)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
	}
	callCtx := s.call(ctx)
	heat, err := s.heatMap(callCtx, ctx.Identity.OrgID, ids, rows)
	if err != nil {
		return nil, err
	}
	authorityWindow := authorityWindowDays(ctx.Args)
	authority, err := s.authorityMap(callCtx, ctx.Identity.OrgID, ids, authorityWindow)
	if err != nil {
		return nil, err
	}
	settings := s.loadSettings(callCtx, ctx.Identity.OrgID)
	sourceType, _ := contract.StringArg(ctx.Args, "sourceType")
	if sourceType == "" {
		sourceType = "all"
	}
	var minAuth *int
	if value, ok := contract.IntArg(ctx.Args, "minAuthoritativeSources"); ok {
		clamped := clampInt(roundHalfAway(float64(value)), 0, 100)
		minAuth = &clamped
	}
	if settings.Force {
		sourceType = "authoritative"
		forced := settings.ForceMin
		if minAuth != nil && *minAuth > forced {
			forced = *minAuth
		}
		minAuth = &forced
	}
	heatFloor, hasHeat := floatArg(ctx.Args, "minHeatScore")
	if hasHeat && heatFloor < 0 {
		heatFloor = 0
	}
	credFloor, hasCred := floatArg(ctx.Args, "minCredibilityScore")
	if hasCred {
		if credFloor < 0 {
			credFloor = 0
		}
		if credFloor > 100 {
			credFloor = 100
		}
	}
	enriched := make([]scoredEvent, 0, len(rows))
	for _, row := range rows {
		entry := scoredEvent{row: row, heat: heat[row.ID], authority: authority[row.ID]}
		if sourceType != "all" && entry.authority.SourceType != sourceType {
			continue
		}
		if hasHeat && entry.heat.Score < heatFloor {
			continue
		}
		if hasCred && entry.authority.Credibility < credFloor {
			continue
		}
		if minAuth != nil && entry.authority.Evidence.AuthoritativeSourceCount < *minAuth {
			continue
		}
		enriched = append(enriched, entry)
	}
	sortBy, _ := contract.StringArg(ctx.Args, "sortBy")
	if sortBy == "" {
		sortBy = "latest"
	}
	sortEvents(enriched, sortBy)
	dedupe := true
	if value, ok := boolArg(ctx.Args, "dedupeSimilar"); ok {
		dedupe = value
	}
	if dedupe {
		enriched = dedupeEvents(enriched)
	}
	if len(enriched) > requested {
		enriched = enriched[:requested]
	}
	out := make([]NewsEventModel, 0, len(enriched))
	for _, entry := range enriched {
		out = append(out, entry.model(false))
	}
	return out, nil
}

type heatProfile struct {
	Breaking bool
	Score    float64
}

type authorityProfile struct {
	SourceType  string
	Credibility float64
	Evidence    NewsEventSourceEvidenceModel
}

type scoredEvent struct {
	row       eventRow
	heat      heatProfile
	authority authorityProfile
}

func (s *service) heatMap(ctx context.Context, orgID string, ids []string, rows []eventRow) (map[string]heatProfile, error) {
	out := make(map[string]heatProfile, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	now := s.clock()
	oneHour := now.Add(-time.Hour)
	fourHours := now.Add(-4 * time.Hour)
	items, err := s.loadHeatItems(ctx, orgID, ids, fourHours)
	if err != nil {
		return nil, err
	}
	lastAt := make(map[string]time.Time, len(rows))
	for _, row := range rows {
		lastAt[row.ID] = row.LastAt
	}
	type agg struct {
		last1h  int
		last4h  int
		sources map[string]struct{}
	}
	grouped := make(map[string]*agg, len(ids))
	for _, id := range ids {
		grouped[id] = &agg{sources: map[string]struct{}{}}
	}
	for _, item := range items {
		bucket := grouped[item.EventID]
		if bucket == nil {
			continue
		}
		bucket.last4h++
		if !item.CreatedAt.Before(oneHour) {
			bucket.last1h++
		}
		if item.SourceID != "" {
			bucket.sources[item.SourceID] = struct{}{}
		}
	}
	for _, id := range ids {
		bucket := grouped[id]
		breaking, score := publicportal.EventHeat(now, lastAt[id], bucket.last1h, bucket.last4h, len(bucket.sources))
		out[id] = heatProfile{Breaking: breaking, Score: score}
	}
	return out, nil
}

func (s *service) authorityMap(ctx context.Context, orgID string, ids []string, windowDays int) (map[string]authorityProfile, error) {
	out := make(map[string]authorityProfile, len(ids))
	empty := authorityProfile{SourceType: "unknown"}
	for _, id := range ids {
		out[id] = empty
	}
	if len(ids) == 0 {
		return out, nil
	}
	since := s.clock().Add(-time.Duration(windowDays) * day)
	items, err := s.loadAuthorityItems(ctx, orgID, ids, since)
	if err != nil {
		return nil, err
	}
	policy := s.loadPolicyJSON(ctx, orgID)
	type agg struct {
		keys          map[string]struct{}
		authoritative map[string]struct{}
		blog          map[string]struct{}
		authItems     int
		blogItems     int
		total         int
	}
	grouped := make(map[string]*agg, len(ids))
	for _, id := range ids {
		grouped[id] = &agg{
			keys:          map[string]struct{}{},
			authoritative: map[string]struct{}{},
			blog:          map[string]struct{}{},
		}
	}
	for _, item := range items {
		bucket := grouped[item.EventID]
		if bucket == nil {
			continue
		}
		class, key := publicportal.ClassifyEventSource(item.SourceLabel, item.URL, policy)
		if key != "" && key != "unknown" {
			bucket.keys[key] = struct{}{}
		}
		bucket.total++
		if class == "authoritative" {
			bucket.authItems++
			if key != "" && key != "unknown" {
				bucket.authoritative[key] = struct{}{}
			}
		} else if class == "blog" {
			bucket.blogItems++
			if key != "" && key != "unknown" {
				bucket.blog[key] = struct{}{}
			}
		}
	}
	for _, id := range ids {
		bucket := grouped[id]
		sourceType, credibility, unique, authCount, blogCount, corroborated := publicportal.EventAuthority(
			len(bucket.keys), len(bucket.authoritative), len(bucket.blog), bucket.authItems, bucket.total,
		)
		out[id] = authorityProfile{
			SourceType:  sourceType,
			Credibility: credibility,
			Evidence: NewsEventSourceEvidenceModel{
				UniqueSourceCount:        clampInt(unique, 0, 10_000),
				AuthoritativeSourceCount: clampInt(authCount, 0, 10_000),
				BlogSourceCount:          clampInt(blogCount, 0, 10_000),
				Corroborated:             corroborated,
			},
		}
	}
	return out, nil
}

func (entry scoredEvent) model(detail bool) NewsEventModel {
	row := entry.row
	bag := timelineFromMetadata(row.Metadata)
	distribution, warning, summary, phases, subEvents := driftFields(bag)
	model := NewsEventModel{
		ID:                               row.ID,
		Status:                           row.Status,
		Language:                         row.Language,
		PrimaryTopic:                     row.PrimaryTopic,
		PrimaryEntity:                    row.PrimaryEntity,
		Title:                            row.Title,
		Summary:                          row.Summary,
		StartAt:                          row.StartAt,
		LastAt:                           row.LastAt,
		ItemCount:                        row.ItemCount,
		RepresentativeProcessedArticleID: row.RepresentativeProcessedArticleID,
		RepresentativeProcessedItemID:    row.RepresentativeProcessedItemID,
		Metadata:                         metadataValue(row.Metadata),
		CategoryDistribution:             distribution,
		TopicDriftWarning:                warning,
		TopicDriftSummary:                summary,
		TimelinePhases:                   phases,
		SubEvents:                        subEvents,
		CreatedAt:                        row.CreatedAt,
		UpdatedAt:                        row.UpdatedAt,
		Breaking:                         entry.heat.Breaking,
		HeatScore:                        entry.heat.Score,
		CredibilityScore:                 entry.authority.Credibility,
		SourceType:                       entry.authority.SourceType,
		SourceEvidence:                   entry.authority.Evidence,
	}
	if model.SourceType == "" {
		model.SourceType = "unknown"
	}
	_ = detail
	return model
}

func sortEvents(rows []scoredEvent, sortBy string) {
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		heat := cmpFloat(b.heat.Score, a.heat.Score)
		cred := cmpFloat(b.authority.Credibility, a.authority.Credibility)
		last := cmpTime(b.row.LastAt, a.row.LastAt)
		switch sortBy {
		case "heat":
			return firstNonZero(heat, cred, last) < 0
		case "credibility":
			return firstNonZero(cred, heat, last) < 0
		default:
			return firstNonZero(last, heat, cred) < 0
		}
	})
}

func cmpFloat(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

func cmpTime(a, b time.Time) int {
	switch {
	case a.Before(b):
		return -1
	case a.After(b):
		return 1
	default:
		return 0
	}
}

func firstNonZero(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func dedupeEvents(rows []scoredEvent) []scoredEvent {
	type kept struct {
		entry  scoredEvent
		tokens map[string]struct{}
		start  time.Time
		last   time.Time
	}
	out := make([]kept, 0, len(rows))
	for _, entry := range rows {
		tokens := eventTokens(entry.row)
		duplicate := false
		for _, existing := range out {
			closeByTime := within(entry.row.StartAt, existing.start) || within(entry.row.LastAt, existing.last)
			if closeByTime && jaccard(tokens, existing.tokens) >= 0.74 {
				duplicate = true
				break
			}
		}
		if !duplicate {
			out = append(out, kept{entry: entry, tokens: tokens, start: entry.row.StartAt, last: entry.row.LastAt})
		}
	}
	result := make([]scoredEvent, len(out))
	for i, item := range out {
		result[i] = item.entry
	}
	return result
}

func within(a, b time.Time) bool {
	if a.IsZero() || b.IsZero() {
		return false
	}
	delta := a.Sub(b)
	if delta < 0 {
		delta = -delta
	}
	return delta <= dedupeWindow
}

func eventTokens(row eventRow) map[string]struct{} {
	parts := strings.Join([]string{deref(row.PrimaryEntity), deref(row.PrimaryTopic), deref(row.Title)}, " ")
	normalized := strings.TrimSpace(tokenSplit.ReplaceAllString(strings.ToLower(parts), " "))
	if normalized == "" {
		return map[string]struct{}{}
	}
	fields := strings.Fields(normalized)
	out := make(map[string]struct{}, len(fields))
	count := 0
	for _, token := range fields {
		if len(token) < 3 && !hanRune.MatchString(token) {
			continue
		}
		out[token] = struct{}{}
		count++
		if count >= 24 {
			break
		}
	}
	return out
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func jaccard(a, b map[string]struct{}) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	small, large := a, b
	if len(b) < len(a) {
		small, large = b, a
	}
	intersection := 0
	for token := range small {
		if _, ok := large[token]; ok {
			intersection++
		}
	}
	union := len(a) + len(b) - intersection
	if union <= 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}
