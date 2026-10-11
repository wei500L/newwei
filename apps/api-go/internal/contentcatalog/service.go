package contentcatalog

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

var errEmbeddingSkipped = errors.New("embedding fallback")

// Service 实现 personalnews.CatalogAPI。
type Service struct {
	db     *sql.DB
	rdb    *redis.Client
	mdb    *mongo.Database
	models *llmembed.Client
}

var _ personalnews.CatalogAPI = (*Service)(nil)

// NewService 组装目录同步、分类和推荐。models 为空时推荐走计数回退。
func NewService(db *sql.DB, rdb *redis.Client, mdb *mongo.Database, models *llmembed.Client) *Service {
	return &Service{db: db, rdb: rdb, mdb: mdb, models: models}
}

// NewModelClient 按 MySQL 网关 profile 构造 embedding/rerank 客户端。
func NewModelClient(db *sql.DB) *llmembed.Client {
	return llmembed.NewClient(db)
}

// EnsureFresh 刷新目录。刷新失败或请求取消时不写成功标记，并返回 nil，调用方继续读旧快照。
func (s *Service) EnsureFresh(ctx context.Context, orgID string) error {
	if err := s.ensureCatalogFresh(ctx, orgID); err != nil {
		log.Printf("contentcatalog: failed to refresh content subscription catalog; continuing with existing snapshot org=%s", orgID)
	}
	return nil
}

// LoadTaxonomy 读取组织分类配置。缺配置时使用 Nest 的默认 taxonomy。
func (s *Service) LoadTaxonomy(ctx context.Context, orgID string) (personalnews.TaxonomyView, error) {
	taxonomy := s.loadTaxonomy(ctx, orgID)
	view := personalnews.TaxonomyView{
		Version: taxonomy.Version,
		ByPath:  make(map[string]personalnews.TaxonomyNode, len(taxonomy.ByPath)),
	}
	for path, node := range taxonomy.ByPath {
		view.ByPath[path] = personalnews.TaxonomyNode{
			Path:        node.Path,
			DisplayName: node.DisplayName,
			Labels:      splitPath(node.Path),
		}
	}
	return view, nil
}

// Resolve 解析目录项。目录里没有的条目做 ad-hoc 分类。
func (s *Service) Resolve(ctx context.Context, orgID string, entries []personalnews.EntryInput) ([]personalnews.CatalogResolution, error) {
	resolved, err := s.resolveEntries(ctx, orgID, entries)
	if err != nil {
		return nil, err
	}
	out := make([]personalnews.CatalogResolution, len(resolved))
	for i, entry := range resolved {
		out[i] = toContract(entry)
	}
	return out, nil
}

// List 返回目录查询的 Nest JSON。
func (s *Service) List(ctx context.Context, orgID, kind, query, taxonomyPath string, limit int) ([]byte, error) {
	if err := s.EnsureFresh(ctx, orgID); err != nil {
		return nil, err
	}
	taxonomy := s.loadTaxonomy(ctx, orgID)
	limit = normalizeListLimit(limit)
	if kind != "" && !knownKind(kind) {
		return marshalCatalog(limit, taxonomy.Version, nil)
	}
	if s.db == nil {
		return nil, errDatabaseUnavailable
	}
	rows, err := s.listRows(ctx, orgID, kind, query, taxonomyPath, limit)
	if err != nil {
		return nil, err
	}
	items := make([]catalogItem, len(rows))
	for i, row := range rows {
		items[i] = mapCatalogRow(row, taxonomy.ByPath, nil)
	}
	return marshalCatalog(limit, taxonomy.Version, items)
}

// Lookup 返回目录命中或 ad-hoc 解析的 Nest JSON。
func (s *Service) Lookup(ctx context.Context, orgID string, entries []personalnews.EntryInput) ([]byte, error) {
	if err := s.EnsureFresh(ctx, orgID); err != nil {
		return nil, err
	}
	taxonomy := s.loadTaxonomy(ctx, orgID)
	normalized := normalizeInput(entries)
	resolved, err := s.resolveNormalized(ctx, orgID, normalized, taxonomy)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	items := make([]catalogItem, len(resolved))
	for i, entry := range resolved {
		items[i] = mapResolutionItem(entry, taxonomy.ByPath, now)
	}
	return marshalCatalog(len(normalized), taxonomy.Version, items)
}

// Recommend 排除已订阅和负向 topic/entity，先向量排序再 rerank，失败时回退到计数。
func (s *Service) Recommend(ctx context.Context, orgID string, limit int, subscribed []personalnews.SubscriptionKey, profile personalnews.PersonalizationProfile) ([]byte, error) {
	if err := s.EnsureFresh(ctx, orgID); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = recommendationLimit
	}
	taxonomy := s.loadTaxonomy(ctx, orgID)
	if s.db == nil {
		return nil, errDatabaseUnavailable
	}
	rows, err := s.recommendationRows(ctx, orgID)
	if err != nil {
		return nil, err
	}
	subscribedKeys := map[string]struct{}{}
	for _, key := range subscribed {
		subscribedKeys[subscriptionKey(key.Kind, key.NormalizedValue)] = struct{}{}
	}
	negativeTopics := keySet(profile.Negative.Topics)
	negativeEntities := keySet(profile.Negative.Entities)
	available := make([]catalogRow, 0, len(rows))
	for _, row := range rows {
		if _, skip := subscribedKeys[subscriptionKey(row.Kind, row.NormalizedValue)]; skip {
			continue
		}
		if row.Kind == personalnews.KindTopic {
			if _, skip := negativeTopics[row.NormalizedValue]; skip {
				continue
			}
		}
		if row.Kind == personalnews.KindEntity {
			if _, skip := negativeEntities[row.NormalizedValue]; skip {
				continue
			}
		}
		available = append(available, row)
	}
	if len(available) == 0 {
		return marshalCatalog(limit, taxonomy.Version, nil)
	}
	fallback := available
	if len(fallback) > limit {
		fallback = fallback[:limit]
	}
	query := buildRecommendationQuery(profile)
	if query == "" {
		return marshalCatalog(limit, taxonomy.Version, mapRows(fallback, taxonomy.ByPath, false))
	}
	ranked, err := s.rankByEmbedding(ctx, orgID, query, available)
	if err != nil && ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil || len(ranked) == 0 {
		return marshalCatalog(limit, taxonomy.Version, mapRows(fallback, taxonomy.ByPath, false))
	}
	pool := ranked
	if len(pool) > recommendationPool {
		pool = pool[:recommendationPool]
	}
	reranked := s.tryRerank(ctx, orgID, query, pool)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	chosen := ranked
	if len(reranked) > 0 {
		chosen = reranked
	}
	ordered := mergeRanked(chosen, available, limit)
	items := make([]catalogItem, len(ordered))
	for i, entry := range ordered {
		items[i] = mapCatalogRow(entry.Row, taxonomy.ByPath, scorePointer(entry))
	}
	return marshalCatalog(limit, taxonomy.Version, items)
}

// RelatedTopics 在同分支主题里排除已订阅项，用当前向量和 rerank 排序，否则按计数。
func (s *Service) RelatedTopics(ctx context.Context, orgID, topic string, limit int, subscribedTopics []string) ([]byte, error) {
	if err := s.EnsureFresh(ctx, orgID); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = relatedTopicLimit
	}
	taxonomy := s.loadTaxonomy(ctx, orgID)
	_, normalized := normalizeValue(topic, personalnews.KindTopic)
	if normalized == "" {
		return marshalCatalog(limit, taxonomy.Version, nil)
	}
	resolved, err := s.resolveNormalized(ctx, orgID, []inputEntry{{
		Kind:            personalnews.KindTopic,
		NormalizedValue: normalized,
		DisplayValue:    cleanDisplay(topic),
	}}, taxonomy)
	if err != nil {
		return nil, err
	}
	if len(resolved) == 0 {
		return marshalCatalog(limit, taxonomy.Version, nil)
	}
	current := resolved[0]
	if s.db == nil {
		return nil, errDatabaseUnavailable
	}
	branch := ""
	if current.TaxonomyPath != nil && *current.TaxonomyPath != "" {
		branch = taxonomyBranchPrefix(*current.TaxonomyPath)
	}
	rows, err := s.relatedRows(ctx, orgID, current.NormalizedValue, branch)
	if err != nil {
		return nil, err
	}
	subscribed := map[string]struct{}{}
	for _, value := range subscribedTopics {
		_, key := normalizeValue(value, personalnews.KindTopic)
		if key != "" {
			subscribed[key] = struct{}{}
		}
	}
	seen := map[string]struct{}{}
	filtered := make([]catalogRow, 0, len(rows))
	for _, row := range rows {
		if _, skip := subscribed[row.NormalizedValue]; skip {
			continue
		}
		if _, dup := seen[row.NormalizedValue]; dup {
			continue
		}
		seen[row.NormalizedValue] = struct{}{}
		filtered = append(filtered, row)
	}
	if len(filtered) == 0 {
		return marshalCatalog(limit, taxonomy.Version, nil)
	}
	queryText := "related topic: " + current.DisplayValue
	if current.TaxonomyPath != nil && *current.TaxonomyPath != "" {
		queryText += "\ntaxonomy: " + *current.TaxonomyPath
	}
	embeddingRanked := rankByVector(current.EmbeddingVector, filtered, relatedTopicPool)
	fallback := embeddingRanked
	if len(fallback) == 0 {
		countRows := filtered
		if len(countRows) > limit {
			countRows = countRows[:limit]
		}
		fallback = make([]scoredRow, len(countRows))
		for i, row := range countRows {
			fallback[i] = scoredRow{Row: row, Score: float64(row.Count), HasScore: true}
		}
	}
	rerankPool := fallback
	if len(rerankPool) > relatedTopicPool {
		rerankPool = rerankPool[:relatedTopicPool]
	}
	reranked := s.tryRerank(ctx, orgID, queryText, rerankPool)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	ordered := fallback
	if len(reranked) > 0 {
		ordered = reranked
	}
	if len(ordered) > limit {
		ordered = ordered[:limit]
	}
	items := make([]catalogItem, len(ordered))
	for i, entry := range ordered {
		items[i] = mapCatalogRow(entry.Row, taxonomy.ByPath, scorePointer(entry))
	}
	return marshalCatalog(limit, taxonomy.Version, items)
}

func (s *Service) resolveEntries(ctx context.Context, orgID string, entries []personalnews.EntryInput) ([]resolution, error) {
	taxonomy := s.loadTaxonomy(ctx, orgID)
	return s.resolveNormalized(ctx, orgID, normalizeInput(entries), taxonomy)
}

func (s *Service) resolveNormalized(ctx context.Context, orgID string, entries []inputEntry, taxonomy taxonomyDescriptor) ([]resolution, error) {
	if len(entries) == 0 {
		return []resolution{}, nil
	}
	if s.db == nil {
		return nil, errDatabaseUnavailable
	}
	existing, err := s.findCatalogEntries(ctx, orgID, entries)
	if err != nil {
		return nil, err
	}
	missing := make([]candidate, 0)
	for _, entry := range entries {
		if _, ok := existing[subscriptionKey(entry.Kind, entry.NormalizedValue)]; ok {
			continue
		}
		missing = append(missing, candidate{
			Kind:            entry.Kind,
			NormalizedValue: entry.NormalizedValue,
			DisplayValue:    entry.DisplayValue,
			LastSeenAt:      time.Now(),
		})
	}
	classified := map[string]resolution{}
	if len(missing) > 0 {
		resolved, err := s.classifyCandidates(ctx, orgID, missing, taxonomy)
		if err != nil {
			return nil, err
		}
		for _, entry := range resolved {
			classified[subscriptionKey(entry.Kind, entry.NormalizedValue)] = entry
		}
	}
	out := make([]resolution, 0, len(entries))
	for _, entry := range entries {
		key := subscriptionKey(entry.Kind, entry.NormalizedValue)
		if row, ok := existing[key]; ok {
			out = append(out, resolutionFromRow(row, taxonomy.Version))
			continue
		}
		if row, ok := classified[key]; ok {
			out = append(out, row)
			continue
		}
		out = append(out, adHocResolution(candidate{
			Kind:            entry.Kind,
			NormalizedValue: entry.NormalizedValue,
			DisplayValue:    entry.DisplayValue,
		}, taxonomy.Version, nil))
	}
	return out, nil
}

func resolutionFromRow(row catalogRow, version string) resolution {
	meta, _ := parseMetadata(row.Metadata)
	var model *string
	if row.EmbeddingModel != "" {
		copied := row.EmbeddingModel
		model = &copied
	}
	taxVersion := version
	if row.TaxonomyVersion != "" {
		taxVersion = row.TaxonomyVersion
	}
	return resolution{
		Kind:             row.Kind,
		NormalizedValue:  row.NormalizedValue,
		DisplayValue:     row.DisplayValue,
		TaxonomyPath:     nullablePath(row),
		TaxonomyVersion:  taxVersion,
		EmbeddingModel:   model,
		EmbeddingVector:  parseVector(row.EmbeddingVector),
		Metadata:         meta,
		MetadataExplicit: true,
		Count:            row.Count,
		LastSeenAt:       row.LastSeenAt,
	}
}

func normalizeListLimit(limit int) int {
	if limit <= 0 {
		return catalogListLimit
	}
	if limit > catalogListLimit {
		return catalogListLimit
	}
	return limit
}

func mapRows(rows []catalogRow, byPath map[string]taxNode, withCountScore bool) []catalogItem {
	items := make([]catalogItem, len(rows))
	for i, row := range rows {
		var score *float64
		if withCountScore {
			value := float64(row.Count)
			score = &value
		}
		items[i] = mapCatalogRow(row, byPath, score)
	}
	return items
}

func keySet(values personalnews.ScoreMap) map[string]struct{} {
	out := make(map[string]struct{}, len(values))
	for key := range values {
		out[key] = struct{}{}
	}
	return out
}

func splitPath(path string) []string {
	out := make([]string, 0, 4)
	for _, part := range strings.Split(path, "/") {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
