package knowledgegraph

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// entityIntelligenceCard is the entityIntelligenceCard root resolver.
func (s *service) entityIntelligenceCard(ctx contract.Context) (any, error) {
	if !s.healthy() {
		return nil, fmt.Errorf("knowledge graph database is not configured")
	}
	input, ok := contract.MapArg(ctx.Args, "input")
	if !ok {
		return nil, fmt.Errorf("input is required")
	}
	entityID, _ := input["entityId"].(string)

	current := s.getSettings(ctx.Ctx, ctx.Identity.OrgID)
	if !current.Enabled {
		return nil, nil
	}

	callCtx := s.call(ctx.Ctx)
	entity, found, err := s.loadEntityByID(callCtx, ctx.Identity.OrgID, entityID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}

	windowDays := clampIntArg(input["windowDays"], 1, 180, 30)
	relatedLimit := clampIntArg(input["relatedLimit"], 1, 50, 12)
	since := s.clock().Add(-time.Duration(windowDays) * 24 * time.Hour)

	aliases, err := s.loadAliases(callCtx, ctx.Identity.OrgID, entity.ID, entity.CanonicalName)
	if err != nil {
		return nil, err
	}
	relationships, err := s.loadRelationships(callCtx, ctx.Identity.OrgID, entity, relatedLimit)
	if err != nil {
		return nil, err
	}
	incoming, err := s.countRows(callCtx, "SELECT COUNT(*) FROM `KnowledgeEdge` WHERE `orgId` = ? AND `toEntityId` = ?", ctx.Identity.OrgID, entity.ID)
	if err != nil {
		return nil, err
	}
	outgoing, err := s.countRows(callCtx, "SELECT COUNT(*) FROM `KnowledgeEdge` WHERE `orgId` = ? AND `fromEntityId` = ?", ctx.Identity.OrgID, entity.ID)
	if err != nil {
		return nil, err
	}
	mentioned, err := s.countRows(callCtx, "SELECT COUNT(*) FROM `ArticleEntityLink` WHERE `orgId` = ? AND `entityId` = ? AND `createdAt` >= ?", ctx.Identity.OrgID, entity.ID, since)
	if err != nil {
		return nil, err
	}
	latestMention, err := s.latestMention(callCtx, ctx.Identity.OrgID, entity.ID)
	if err != nil {
		return nil, err
	}
	recentEvents, err := s.countRows(callCtx, "SELECT COUNT(*) FROM `NewsEvent` WHERE `orgId` = ? AND `primaryEntity` = ? AND `lastAt` >= ?", ctx.Identity.OrgID, entity.CanonicalName, since)
	if err != nil {
		return nil, err
	}
	sentimentSeries, err := s.loadSentimentSeries(callCtx, ctx.Identity.OrgID, entity, since)
	if err != nil {
		return nil, err
	}
	avgSentiment, negativeRatio := sentimentTotals(sentimentSeries)

	nodes := make([]KnowledgeGraphNodeModel, 0, len(relationships)+1)
	nodeSeen := map[string]bool{entity.ID: true}
	nodes = append(nodes, entity.node())
	edges := make([]KnowledgeGraphEdgeModel, 0, len(relationships))
	for _, relationship := range relationships {
		if !nodeSeen[relationship.Neighbor.ID] {
			nodeSeen[relationship.Neighbor.ID] = true
			nodes = append(nodes, relationship.Neighbor)
		}
		edges = append(edges, relationship.Edge)
	}

	generatedAt := s.clock()
	return &EntityIntelligenceCardModel{
		Entity:  entity.node(),
		Aliases: aliases,
		Metrics: EntityIntelligenceMetricsModel{
			RelationshipCount:     incoming + outgoing,
			IncomingEdgeCount:     incoming,
			OutgoingEdgeCount:     outgoing,
			MentionedArticleCount: mentioned,
			RecentEventCount:      recentEvents,
			AvgSentiment:          avgSentiment,
			NegativeRatio:         negativeRatio,
			LatestMentionAt:       latestMention,
		},
		Relationships:   relationships,
		SentimentSeries: sentimentSeries,
		Neighborhood: KnowledgeGraphModel{
			Seed:  entity.node(),
			Nodes: nodes,
			Edges: edges,
			Metadata: KnowledgeGraphMetadataModel{
				TotalNodes:  len(nodes),
				TotalEdges:  len(edges),
				GeneratedAt: generatedAt,
			},
		},
		GeneratedAt: generatedAt,
	}, nil
}

// entityIntelligenceEvidence is the entityIntelligenceEvidence root resolver.
// The root permission is dashboards.read; items.read is checked again before
// any content is returned.
func (s *service) entityIntelligenceEvidence(ctx contract.Context) (any, error) {
	if !s.healthy() {
		return nil, fmt.Errorf("knowledge graph database is not configured")
	}
	input, ok := contract.MapArg(ctx.Args, "input")
	if !ok {
		return nil, fmt.Errorf("input is required")
	}
	entityID, _ := input["entityId"].(string)

	current := s.getSettings(ctx.Ctx, ctx.Identity.OrgID)
	if !current.Enabled {
		return nil, nil
	}

	callCtx := s.call(ctx.Ctx)
	entity, found, err := s.loadEntityByID(callCtx, ctx.Identity.OrgID, entityID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}

	if !ctx.Identity.Has("items.read") {
		return &EntityIntelligenceEvidenceModel{
			Restricted:  true,
			Events:      []EntityIntelligenceEventModel{},
			Articles:    []EntityIntelligenceEvidenceArticleModel{},
			GeneratedAt: s.clock(),
		}, nil
	}

	windowDays := clampIntArg(input["windowDays"], 1, 180, 30)
	eventsLimit := clampIntArg(input["eventsLimit"], 1, 50, 10)
	evidenceLimit := clampIntArg(input["evidenceLimit"], 1, 50, 12)
	since := s.clock().Add(-time.Duration(windowDays) * 24 * time.Hour)

	events, err := s.loadEvents(callCtx, ctx.Identity.OrgID, entity.CanonicalName, since, eventsLimit)
	if err != nil {
		return nil, err
	}
	articles, err := s.loadEvidenceArticles(callCtx, ctx.Identity.OrgID, entity.ID, since, evidenceLimit)
	if err != nil {
		return nil, err
	}

	return &EntityIntelligenceEvidenceModel{
		Restricted:  false,
		Events:      events,
		Articles:    articles,
		GeneratedAt: s.clock(),
	}, nil
}

// knowledgeEntityByName is the knowledgeEntityByName root resolver.
func (s *service) knowledgeEntityByName(ctx contract.Context) (any, error) {
	if !s.healthy() {
		return nil, fmt.Errorf("knowledge graph database is not configured")
	}
	name, ok := contract.StringArg(ctx.Args, "name")
	if !ok {
		return nil, fmt.Errorf("name is required")
	}
	var entityType *string
	if raw, present := contract.StringArg(ctx.Args, "type"); present {
		if value, valid := validEntityType(raw); valid {
			entityType = &value
		}
	}

	current := s.getSettings(ctx.Ctx, ctx.Identity.OrgID)
	if !current.Enabled {
		return nil, nil
	}

	entity, found, err := s.resolveEntity(s.call(ctx.Ctx), ctx.Identity.OrgID, name, entityType)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	node := entity.node()
	return &node, nil
}

func (s *service) loadEntityByID(ctx context.Context, orgID, entityID string) (entityRow, bool, error) {
	var row entityRow
	var properties []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT `id`, `type`, `canonicalName`, `properties` FROM `KnowledgeEntity` WHERE `id` = ? AND `orgId` = ? LIMIT 1",
		entityID, orgID,
	).Scan(&row.ID, &row.Type, &row.CanonicalName, &properties)
	if err == sql.ErrNoRows {
		return entityRow{}, false, nil
	}
	if err != nil {
		return entityRow{}, false, fmt.Errorf("query knowledge entity: %w", err)
	}
	row.Properties = properties
	return row, true, nil
}

func (s *service) countRows(ctx context.Context, query string, args ...any) (int, error) {
	var count int
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("count rows: %w", err)
	}
	return count, nil
}

func (s *service) latestMention(ctx context.Context, orgID, entityID string) (*time.Time, error) {
	var createdAt time.Time
	err := s.db.QueryRowContext(ctx,
		"SELECT `createdAt` FROM `ArticleEntityLink` WHERE `orgId` = ? AND `entityId` = ? ORDER BY `createdAt` DESC LIMIT 1",
		orgID, entityID,
	).Scan(&createdAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("query latest mention: %w", err)
	}
	return &createdAt, nil
}

func (s *service) loadAliases(ctx context.Context, orgID, entityID, canonicalName string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `alias` FROM `KnowledgeEntityAlias` WHERE `orgId` = ? AND `entityId` = ? ORDER BY `createdAt` ASC",
		orgID, entityID,
	)
	if err != nil {
		return nil, fmt.Errorf("query entity aliases: %w", err)
	}
	defer rows.Close()
	seen := map[string]bool{}
	aliases := make([]string, 0)
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("scan entity alias: %w", err)
		}
		alias := trimSpace(raw)
		if alias == "" || alias == canonicalName || seen[alias] {
			continue
		}
		seen[alias] = true
		aliases = append(aliases, alias)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return aliases, nil
}

func (s *service) loadRelationships(ctx context.Context, orgID string, entity entityRow, limit int) ([]EntityIntelligenceRelationshipModel, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `fromEntityId`, `toEntityId`, `type`, `weight`, `confidence`, `properties` "+
			"FROM `KnowledgeEdge` WHERE `orgId` = ? AND (`fromEntityId` = ? OR `toEntityId` = ?) "+
			"ORDER BY `weight` DESC, `confidence` DESC, `updatedAt` DESC LIMIT ?",
		orgID, entity.ID, entity.ID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query entity relationships: %w", err)
	}
	defer rows.Close()
	edges := make([]edgeRow, 0, limit)
	for rows.Next() {
		var row edgeRow
		var properties []byte
		if err := rows.Scan(&row.ID, &row.From, &row.To, &row.Type, &row.Weight, &row.Confidence, &properties); err != nil {
			return nil, fmt.Errorf("scan entity relationship: %w", err)
		}
		row.Properties = properties
		edges = append(edges, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(edges) == 0 {
		return []EntityIntelligenceRelationshipModel{}, nil
	}

	neighborIDs := make([]string, 0, len(edges))
	seen := map[string]bool{}
	for _, edge := range edges {
		neighborID := edge.From
		if edge.From == entity.ID {
			neighborID = edge.To
		}
		if !seen[neighborID] {
			seen[neighborID] = true
			neighborIDs = append(neighborIDs, neighborID)
		}
	}
	neighbors, err := s.loadEntitiesByIDs(ctx, neighborIDs)
	if err != nil {
		return nil, err
	}
	stats, err := s.loadEvidenceStats(ctx, edgeIDs(edges))
	if err != nil {
		return nil, err
	}

	out := make([]EntityIntelligenceRelationshipModel, 0, len(edges))
	for _, edge := range edges {
		direction := "incoming"
		neighborID := edge.From
		if edge.From == entity.ID {
			direction = "outgoing"
			neighborID = edge.To
		}
		neighbor, ok := neighbors[neighborID]
		if !ok {
			continue
		}
		stat := stats[edge.ID]
		out = append(out, EntityIntelligenceRelationshipModel{
			Direction:        direction,
			Edge:             edge.model(),
			Neighbor:         neighbor.node(),
			EvidenceCount:    stat.count,
			LatestEvidenceAt: stat.latest,
		})
	}
	return out, nil
}

func edgeIDs(edges []edgeRow) []string {
	out := make([]string, len(edges))
	for i, edge := range edges {
		out[i] = edge.ID
	}
	return out
}

func (s *service) loadEntitiesByIDs(ctx context.Context, ids []string) (map[string]entityRow, error) {
	out := map[string]entityRow{}
	if len(ids) == 0 {
		return out, nil
	}
	entities, err := s.loadEntities(ctx, "`id` IN ("+placeholders(len(ids))+")", stringArgs(ids)...)
	if err != nil {
		return nil, err
	}
	for _, entity := range entities {
		out[entity.ID] = entity
	}
	return out, nil
}

type evidenceStat struct {
	count  int
	latest *time.Time
}

func (s *service) loadEvidenceStats(ctx context.Context, ids []string) (map[string]evidenceStat, error) {
	out := map[string]evidenceStat{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `edgeId`, COUNT(*), MAX(`createdAt`) FROM `KnowledgeEdgeEvidence` WHERE `edgeId` IN ("+placeholders(len(ids))+") GROUP BY `edgeId`",
		stringArgs(ids)...,
	)
	if err != nil {
		return nil, fmt.Errorf("query edge evidence stats: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var edgeID string
		var count int
		var latest sql.NullTime
		if err := rows.Scan(&edgeID, &count, &latest); err != nil {
			return nil, fmt.Errorf("scan edge evidence stats: %w", err)
		}
		out[edgeID] = evidenceStat{count: count, latest: nullTime(latest)}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *service) loadSentimentSeries(ctx context.Context, orgID string, entity entityRow, since time.Time) ([]EntitySentimentSnapshotModel, error) {
	exact, err := s.loadSentimentRows(ctx,
		"SELECT `entityName`, `entityType`, `bucketStart`, `totalDocs`, `negativeDocs`, `positiveDocs`, `neutralDocs`, `scoreSum`, `avgScore`, `negativeRatio`, `evidenceProcessedItemIds` "+
			"FROM `EntitySentimentSnapshot` WHERE `orgId` = ? AND `entityName` = ? AND `entityType` = ? AND `bucketStart` >= ? ORDER BY `bucketStart` ASC",
		orgID, entity.CanonicalName, entity.Type, since,
	)
	if err != nil {
		return nil, err
	}
	if len(exact) > 0 {
		return exact, nil
	}
	fallback, err := s.loadSentimentRows(ctx,
		"SELECT `entityName`, `entityType`, `bucketStart`, `totalDocs`, `negativeDocs`, `positiveDocs`, `neutralDocs`, `scoreSum`, `avgScore`, `negativeRatio`, `evidenceProcessedItemIds` "+
			"FROM `EntitySentimentSnapshot` WHERE `orgId` = ? AND `entityName` = ? AND `entityType` = '' AND `bucketStart` >= ? ORDER BY `bucketStart` ASC",
		orgID, entity.CanonicalName, since,
	)
	if err != nil {
		return nil, err
	}
	if len(fallback) == 0 {
		return fallback, nil
	}
	// Legacy "" rows are ambiguous. Only use them when this name has no other
	// typed snapshots; otherwise a homonym's sentiment would leak here.
	otherTyped, err := s.countRows(ctx,
		"SELECT COUNT(*) FROM `EntitySentimentSnapshot` WHERE `orgId` = ? AND `entityName` = ? AND `entityType` NOT IN ('', ?)",
		orgID, entity.CanonicalName, entity.Type,
	)
	if err != nil {
		return nil, err
	}
	if otherTyped > 0 {
		return []EntitySentimentSnapshotModel{}, nil
	}
	return fallback, nil
}

func (s *service) loadSentimentRows(ctx context.Context, query string, args ...any) ([]EntitySentimentSnapshotModel, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query entity sentiment snapshots: %w", err)
	}
	defer rows.Close()
	out := make([]EntitySentimentSnapshotModel, 0)
	for rows.Next() {
		var item EntitySentimentSnapshotModel
		var evidence []byte
		if err := rows.Scan(&item.EntityName, &item.EntityType, &item.BucketStart, &item.TotalDocs,
			&item.NegativeDocs, &item.PositiveDocs, &item.NeutralDocs, &item.ScoreSum,
			&item.AvgScore, &item.NegativeRatio, &evidence); err != nil {
			return nil, fmt.Errorf("scan entity sentiment snapshot: %w", err)
		}
		item.EvidenceProcessedItemIDs = decodeJSON(evidence)
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func sentimentTotals(rows []EntitySentimentSnapshotModel) (*float64, *float64) {
	totalDocs := 0
	scoreSum := 0
	negativeDocs := 0
	for _, row := range rows {
		totalDocs += row.TotalDocs
		scoreSum += row.ScoreSum
		negativeDocs += row.NegativeDocs
	}
	if totalDocs <= 0 {
		return nil, nil
	}
	avg := float64(scoreSum) / float64(totalDocs)
	ratio := float64(negativeDocs) / float64(totalDocs)
	return &avg, &ratio
}

func (s *service) loadEvents(ctx context.Context, orgID, canonicalName string, since time.Time, limit int) ([]EntityIntelligenceEventModel, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `status`, `title`, `summary`, `primaryTopic`, `primaryEntity`, `startAt`, `lastAt` "+
			"FROM `NewsEvent` WHERE `orgId` = ? AND `primaryEntity` = ? AND `lastAt` >= ? "+
			"ORDER BY `lastAt` DESC, `updatedAt` DESC LIMIT ?",
		orgID, canonicalName, since, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query entity events: %w", err)
	}
	defer rows.Close()
	events := make([]EntityIntelligenceEventModel, 0, limit)
	ids := make([]string, 0, limit)
	for rows.Next() {
		var item EntityIntelligenceEventModel
		var title, summary, primaryTopic, primaryEntity sql.NullString
		if err := rows.Scan(&item.ID, &item.Status, &title, &summary, &primaryTopic, &primaryEntity, &item.StartAt, &item.LastAt); err != nil {
			return nil, fmt.Errorf("scan entity event: %w", err)
		}
		item.Title = nullString(title)
		item.Summary = nullString(summary)
		item.PrimaryTopic = nullString(primaryTopic)
		item.PrimaryEntity = nullString(primaryEntity)
		events = append(events, item)
		ids = append(ids, item.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return events, nil
	}
	counts, err := s.loadEventItemCounts(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range events {
		events[i].ItemCount = counts[events[i].ID]
	}
	return events, nil
}

func (s *service) loadEventItemCounts(ctx context.Context, ids []string) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `eventId`, COUNT(*) FROM `NewsEventItem` WHERE `eventId` IN ("+placeholders(len(ids))+") GROUP BY `eventId`",
		stringArgs(ids)...,
	)
	if err != nil {
		return nil, fmt.Errorf("query news event item counts: %w", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var eventID string
		var count int
		if err := rows.Scan(&eventID, &count); err != nil {
			return nil, fmt.Errorf("scan news event item count: %w", err)
		}
		out[eventID] = count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *service) loadEvidenceArticles(ctx context.Context, orgID, entityID string, since time.Time, limit int) ([]EntityIntelligenceEvidenceArticleModel, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT l.`articleId`, l.`mention`, l.`confidence`, l.`createdAt`, "+
			"a.`url`, a.`sourceLabel`, a.`titleGuess`, a.`language`, a.`crawlAt`, "+
			"p.`title`, p.`summary`, p.`language` "+
			"FROM `ArticleEntityLink` l "+
			"INNER JOIN `Article` a ON a.`id` = l.`articleId` "+
			"LEFT JOIN `ProcessedArticle` p ON p.`articleId` = a.`id` "+
			"WHERE l.`orgId` = ? AND l.`entityId` = ? AND l.`createdAt` >= ? "+
			"ORDER BY l.`createdAt` DESC LIMIT ?",
		orgID, entityID, since, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query entity evidence articles: %w", err)
	}
	defer rows.Close()
	out := make([]EntityIntelligenceEvidenceArticleModel, 0, limit)
	for rows.Next() {
		var item EntityIntelligenceEvidenceArticleModel
		var mention, sourceLabel, titleGuess, articleLanguage sql.NullString
		var confidence sql.NullFloat64
		var processedTitle, processedSummary, processedLanguage sql.NullString
		if err := rows.Scan(&item.Article.ID, &mention, &confidence, &item.LinkedAt,
			&item.Article.URL, &sourceLabel, &titleGuess, &articleLanguage, &item.Article.CrawlAt,
			&processedTitle, &processedSummary, &processedLanguage); err != nil {
			return nil, fmt.Errorf("scan entity evidence article: %w", err)
		}
		item.Mention = nullString(mention)
		item.Confidence = nullFloat(confidence)
		item.Article.SourceLabel = nullString(sourceLabel)
		if processedTitle.Valid {
			item.Article.Title = nullString(processedTitle)
		} else {
			item.Article.Title = nullString(titleGuess)
		}
		item.Article.Summary = nullString(processedSummary)
		if processedLanguage.Valid {
			item.Article.Language = nullString(processedLanguage)
		} else {
			item.Article.Language = nullString(articleLanguage)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
