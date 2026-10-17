package newsindicator

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	associationChunkSize  = 100
	backtestRetentionDays = 30
	maxPointsPerIndicator = 50_000
	lockTimeoutSeconds    = 10
	defaultListLimit      = 50
	defaultBacktestsLimit = 10
)

// queryer 统一 *sql.DB / *sql.Tx / *sql.Conn 的读取接口。
type queryer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// rowScanner 统一 *sql.Row / *sql.Rows。
type rowScanner interface {
	Scan(dest ...any) error
}

// metricsToEvaluate 与 TS 的 metricsToEvaluate 顺序一致。
var metricsToEvaluate = []string{"volume", "avg_score", "negative_ratio"}

// Service 承载 SQL、数学与响应构造。handler 只做路由与鉴权。
type Service struct {
	db    *sql.DB
	redis *redis.Client
}

func NewService(db *sql.DB, redis *redis.Client) *Service {
	return &Service{db: db, redis: redis}
}

func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID 写入 Prisma cuid 列（MySQL 无客户端默认值，形状与既有批次一致）。
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// listOptions 是 GET /associations 的解析结果。limit 为 nil 表示缺省。
type listOptions struct {
	limit         *float64
	indicatorSlug string
	scopeType     string
	scopeKey      string
	featureMetric string
}

// getOptions 是 GET /associations/:id 的解析结果。backtestsLimit 为 nil 表示缺省。
type getOptions struct {
	backtestsLimit *float64
}

const associationSelect = `a.id, a.orgId, a.scopeType, a.scopeKey, a.scopeKeyType, a.featureMetric, a.indicatorItemId,
 a.windowDays, a.lagDays, a.correlation, a.pValue, a.sampleSize,
 a.analyzedStartAt, a.analyzedEndAt, a.metadata, a.lastEvaluatedAt, a.createdAt, a.updatedAt,
 i.id, i.slug, i.displayName, i.groupLabel, i.description, i.sourceFunction, i.sourceEndpoint, i.sourceDocUrl,
 i.valueType, i.defaultUnit, i.defaultFrequency, i.responseAdapter, i.isActive, i.metadata, i.createdAt, i.updatedAt`

const backtestSelect = `id, orgId, associationId, status, windowStart, windowEnd, config, metrics, error, createdAt, updatedAt`

func scanAssociation(row rowScanner) (associationRecord, error) {
	var record associationRecord
	err := row.Scan(
		&record.id, &record.orgID, &record.scopeType, &record.scopeKey, &record.scopeKeyType,
		&record.featureMetric, &record.indicatorItemID, &record.windowDays, &record.lagDays,
		&record.correlation, &record.pValue, &record.sampleSize,
		&record.analyzedStartAt, &record.analyzedEndAt, &record.metadata, &record.lastEvaluatedAt,
		&record.createdAt, &record.updatedAt,
		&record.item.id, &record.item.slug, &record.item.displayName, &record.item.groupLabel,
		&record.item.description, &record.item.sourceFunction, &record.item.sourceEndpoint,
		&record.item.sourceDocURL, &record.item.valueType, &record.item.defaultUnit,
		&record.item.defaultFrequency, &record.item.responseAdapter, &record.item.isActive,
		&record.item.metadata, &record.item.createdAt, &record.item.updatedAt,
	)
	return record, err
}

func scanBacktest(row rowScanner) (backtestRecord, error) {
	var record backtestRecord
	err := row.Scan(
		&record.id, &record.orgID, &record.associationID, &record.status,
		&record.windowStart, &record.windowEnd, &record.config, &record.metrics,
		&record.err, &record.createdAt, &record.updatedAt,
	)
	return record, err
}

// ListAssociations 对齐 listAssociations：orgId 过滤 + 可选枚举过滤 +
// indicatorItem.slug 过滤；lastEvaluatedAt desc、correlation desc；返回
// Prisma 原始行结构（含完整 indicatorItem，以及每个关联最新的 1 条 backtest）。
func (s *Service) ListAssociations(ctx context.Context, orgID string, options listOptions) ([]associationJSON, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("news indicator store is not configured")
	}
	limit := defaultListLimit
	if options.limit != nil {
		limit = clampIntTrunc(int(math.Trunc(*options.limit)), 1, 200)
	}
	scopeKey := strings.TrimSpace(options.scopeKey)
	indicatorSlug := strings.TrimSpace(options.indicatorSlug)

	where := []string{"a.orgId = ?"}
	args := []any{orgID}
	if options.scopeType != "" {
		where = append(where, "a.scopeType = ?")
		args = append(args, options.scopeType)
	}
	if scopeKey != "" {
		where = append(where, "a.scopeKey = ?")
		args = append(args, scopeKey)
	}
	if options.featureMetric != "" {
		where = append(where, "a.featureMetric = ?")
		args = append(args, options.featureMetric)
	}
	if indicatorSlug != "" {
		where = append(where, "i.slug = ?")
		args = append(args, indicatorSlug)
	}
	args = append(args, limit)

	query := "SELECT " + associationSelect +
		" FROM NewsIndicatorAssociation a JOIN EconomicDataItem i ON i.id = a.indicatorItemId" +
		" WHERE " + strings.Join(where, " AND ") +
		" ORDER BY a.lastEvaluatedAt DESC, a.correlation DESC LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]associationRecord, 0, limit)
	for rows.Next() {
		record, err := scanAssociation(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	ids := make([]string, 0, len(records))
	for _, record := range records {
		ids = append(ids, record.id)
	}
	latest, err := loadLatestBacktests(ctx, s.db, ids)
	if err != nil {
		return nil, err
	}

	out := make([]associationJSON, 0, len(records))
	for _, record := range records {
		items := latest[record.id]
		if items == nil {
			items = []backtestJSON{}
		}
		out = append(out, toAssociationJSON(record, &items))
	}
	return out, nil
}

// GetAssociation 对齐 getAssociation：orgId + id 的 findFirst；找不到返回
// (nil, nil)（HTTP 200 空响应，不改成 404）。backtestsLimit=0 时不返回
// backtests 字段；>0 时返回 createdAt desc 的最多 backtestsLimit 条。
func (s *Service) GetAssociation(ctx context.Context, orgID, id string, options getOptions) (*associationJSON, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("news indicator store is not configured")
	}
	row := s.db.QueryRowContext(ctx,
		"SELECT "+associationSelect+
			" FROM NewsIndicatorAssociation a JOIN EconomicDataItem i ON i.id = a.indicatorItemId"+
			" WHERE a.orgId = ? AND a.id = ? LIMIT 1", orgID, id)
	record, err := scanAssociation(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	limit := defaultBacktestsLimit
	if options.backtestsLimit != nil {
		limit = clampIntTrunc(int(math.Trunc(*options.backtestsLimit)), 0, 100)
	}
	var backtests *[]backtestJSON
	if limit > 0 {
		items, err := loadBacktestsForAssociation(ctx, s.db, record.id, limit)
		if err != nil {
			return nil, err
		}
		backtests = &items
	}
	out := toAssociationJSON(record, backtests)
	return &out, nil
}

// loadLatestBacktests 取每个关联最新（createdAt desc）的 1 条。
func loadLatestBacktests(ctx context.Context, q queryer, ids []string) (map[string][]backtestJSON, error) {
	out := map[string][]backtestJSON{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	query := "SELECT " + backtestSelect + " FROM NewsIndicatorAssociationBacktestRun" +
		" WHERE associationId IN (" + placeholders(len(ids)) + ") ORDER BY associationId ASC, createdAt DESC"
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		record, err := scanBacktest(rows)
		if err != nil {
			return nil, err
		}
		if len(out[record.associationID]) >= 1 {
			continue
		}
		out[record.associationID] = append(out[record.associationID], toBacktestJSON(record))
	}
	return out, rows.Err()
}

func loadBacktestsForAssociation(ctx context.Context, q queryer, associationID string, limit int) ([]backtestJSON, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT "+backtestSelect+" FROM NewsIndicatorAssociationBacktestRun"+
			" WHERE associationId = ? ORDER BY createdAt DESC LIMIT ?", associationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []backtestJSON{}
	for rows.Next() {
		record, err := scanBacktest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, toBacktestJSON(record))
	}
	return out, rows.Err()
}

// RefreshOrg 对齐 refreshOrg：整个刷新在按组织的 MySQL 会话锁内执行，
// 每个 chunk 的 upsert、过期回测清理与新回测插入在同一个事务里。
func (s *Service) RefreshOrg(ctx context.Context, orgID string) (refreshResponse, error) {
	if s == nil || s.db == nil {
		return refreshResponse{}, errors.New("news indicator store is not configured")
	}
	var result refreshResponse
	err := s.withOrgLock(ctx, orgID, func(ctx context.Context, conn *sql.Conn) error {
		var locked error
		result, locked = s.refreshOrgLocked(ctx, conn, orgID)
		return locked
	})
	return result, err
}

// withOrgLock 在专用连接上持有 GET_LOCK（会话锁），整个 refreshOrg 完成后
// RELEASE_LOCK，与 situation-monitor 的用户锁模式一致。
func (s *Service) withOrgLock(ctx context.Context, orgID string, fn func(context.Context, *sql.Conn) error) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	name := orgLockName(orgID)
	var acquired sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", name, lockTimeoutSeconds).Scan(&acquired); err != nil {
		return err
	}
	if !acquired.Valid || acquired.Int64 != 1 {
		return errLockNotAcquired
	}
	defer releaseLock(conn, name)
	return fn(ctx, conn)
}

func releaseLock(conn *sql.Conn, name string) {
	relCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = conn.ExecContext(relCtx, "SELECT RELEASE_LOCK(?)", name)
}

// orgLockName 锁名规则：ni:<orgId>；超过 MySQL 64 字符上限时用
// ni: + sha256(orgId) 前 60 位十六进制。
func orgLockName(orgID string) string {
	raw := "ni:" + orgID
	if len([]rune(raw)) <= 64 {
		return raw
	}
	sum := sha256.Sum256([]byte(orgID))
	return "ni:" + hex.EncodeToString(sum[:])[:60]
}

type indicatorKey struct {
	id   string
	slug string
}

type entityKey struct {
	name string
	kind string
}

type featureRow struct {
	totalDocs     int
	avgScore      float64
	negativeRatio float64
}

// featureSeries 保留 key 的插入顺序（对齐 TS Map 的迭代顺序）。
type featureSeries struct {
	order []string
	byKey map[string]map[string]DailySeries
}

func newFeatureSeries() *featureSeries {
	return &featureSeries{byKey: map[string]map[string]DailySeries{}}
}

func (f *featureSeries) set(key, metric string, bucket int64, value float64) {
	metrics, ok := f.byKey[key]
	if !ok {
		metrics = map[string]DailySeries{}
		f.byKey[key] = metrics
		f.order = append(f.order, key)
	}
	series, ok := metrics[metric]
	if !ok {
		series = DailySeries{}
		metrics[metric] = series
	}
	series[bucket] = value
}

type candidate struct {
	scopeType    string
	scopeKey     string
	scopeKeyType string
	metric       string
	series       DailySeries
}

type scoredEntry struct {
	candidate candidate
	best      CorrelationResult
	all       []CorrelationResult
}

type associationKey struct {
	orgID           string
	scopeType       string
	scopeKey        string
	scopeKeyType    string
	featureMetric   string
	indicatorItemID string
}

type associationValues struct {
	windowDays      int
	lagDays         int
	correlation     float64
	pValue          float64
	sampleSize      int
	analyzedStartAt time.Time
	analyzedEndAt   time.Time
	lastEvaluatedAt time.Time
	metadata        []byte
}

type backtestData struct {
	status      string
	windowStart time.Time
	windowEnd   time.Time
	config      []byte
	metrics     []byte
}

type pendingWrite struct {
	key      associationKey
	values   associationValues
	backtest backtestData
}

type associationMetadataJSON struct {
	IndicatorSlug       string              `json:"indicatorSlug"`
	LagMetrics          []CorrelationResult `json:"lagMetrics"`
	TrainingTargetEndAt string              `json:"trainingTargetEndAt"`
	HoldoutDays         int                 `json:"holdoutDays"`
}

type skippedMetrics struct {
	Triggers         int     `json:"triggers"`
	EvaluatedSignals int     `json:"evaluatedSignals"`
	Hits             int     `json:"hits"`
	HitRate          float64 `json:"hitRate"`
	Skipped          string  `json:"skipped"`
}

func (s *Service) refreshOrgLocked(ctx context.Context, conn *sql.Conn, orgID string) (refreshResponse, error) {
	settings := s.loadSettings(ctx, orgID, conn)
	if !settings.Enabled || len(settings.IndicatorSlugs) == 0 {
		return refreshResponse{}, nil
	}

	indicators, err := loadActiveIndicators(ctx, conn, settings.IndicatorSlugs)
	if err != nil {
		return refreshResponse{}, err
	}
	if len(indicators) == 0 {
		return refreshResponse{}, nil
	}

	analyzedEndAtMs := ToUtcDayStartMs(time.Now())
	analyzedStartAtMs := analyzedEndAtMs - int64(settings.WindowDays)*dayMs
	maxHoldoutDays := maxInt(0, settings.WindowDays-maxInt(settings.MinSampleSize, settings.BacktestBaselineDays))
	holdoutDays := minInt(maxInt(settings.BacktestHoldoutDays, 0), maxHoldoutDays)
	holdoutStartDayMs := analyzedEndAtMs - int64(holdoutDays)*dayMs

	analyzedEndAt := time.UnixMilli(analyzedEndAtMs).UTC()
	analyzedStartAt := time.UnixMilli(analyzedStartAtMs).UTC()
	holdoutStartAt := time.UnixMilli(holdoutStartDayMs).UTC()

	topEntities, err := loadTopEntityKeys(ctx, conn, orgID, analyzedStartAt, settings.TopEntities)
	if err != nil {
		return refreshResponse{}, err
	}
	topTopics, err := loadTopTopicKeys(ctx, conn, orgID, analyzedStartAt, settings.TopTopics)
	if err != nil {
		return refreshResponse{}, err
	}
	entitySeries, err := loadEntityFeatureSeries(ctx, conn, orgID, analyzedStartAt, topEntities)
	if err != nil {
		return refreshResponse{}, err
	}
	topicSeries, err := loadTopicFeatureSeries(ctx, conn, orgID, analyzedStartAt, topTopics)
	if err != nil {
		return refreshResponse{}, err
	}
	itemIDs := make([]string, 0, len(indicators))
	for _, indicator := range indicators {
		itemIDs = append(itemIDs, indicator.id)
	}
	pointsByItem, err := loadIndicatorPointsByItem(ctx, conn, itemIDs, analyzedStartAt, analyzedEndAt)
	if err != nil {
		return refreshResponse{}, err
	}

	evaluatedAt := nowMillis()
	pending := []pendingWrite{}

	for _, indicator := range indicators {
		points := pointsByItem[indicator.id]
		dailyValues := BuildDailyEconomicValues(points)
		targetReturns := BuildDailyReturns(dailyValues)

		candidates := []candidate{}
		for _, key := range entitySeries.order {
			byMetric := entitySeries.byKey[key]
			name, kind := splitEntityKey(key)
			if name == "" {
				continue
			}
			for _, metric := range metricsToEvaluate {
				series, ok := byMetric[metric]
				if !ok || len(series) == 0 {
					continue
				}
				candidates = append(candidates, candidate{
					scopeType:    "entity",
					scopeKey:     name,
					scopeKeyType: kind,
					metric:       metric,
					series:       series,
				})
			}
		}
		for _, topic := range topicSeries.order {
			byMetric := topicSeries.byKey[topic]
			for _, metric := range metricsToEvaluate {
				series, ok := byMetric[metric]
				if !ok || len(series) == 0 {
					continue
				}
				candidates = append(candidates, candidate{
					scopeType:    "topic",
					scopeKey:     topic,
					scopeKeyType: "",
					metric:       metric,
					series:       series,
				})
			}
		}

		scored := []scoredEntry{}
		for _, item := range candidates {
			lagOptions := LagSearchOptions{
				MaxLagDays:    settings.MaxLagDays,
				MinSampleSize: settings.MinSampleSize,
			}
			if holdoutDays > 0 {
				lagOptions.MaxTargetDayMsExclusive = holdoutStartDayMs
				lagOptions.HasMaxTargetDayMs = true
			}
			best, all := ComputeBestLagCorrelation(item.series, targetReturns, lagOptions)
			if best == nil {
				continue
			}
			if math.Abs(best.Correlation) < settings.MinAbsCorrelation {
				continue
			}
			if best.PValue > settings.MaxPValue {
				continue
			}
			scored = append(scored, scoredEntry{candidate: item, best: *best, all: all})
		}

		sort.SliceStable(scored, func(i, j int) bool {
			return math.Abs(scored[i].best.Correlation) > math.Abs(scored[j].best.Correlation)
		})
		limit := settings.MaxAssociationsPerIndicator
		if limit > len(scored) {
			limit = len(scored)
		}

		for _, entry := range scored[:limit] {
			metadataJSON, err := json.Marshal(associationMetadataJSON{
				IndicatorSlug:       indicator.slug,
				LagMetrics:          entry.all,
				TrainingTargetEndAt: iso(holdoutStartAt),
				HoldoutDays:         holdoutDays,
			})
			if err != nil {
				return refreshResponse{}, err
			}
			backtestConfig := BacktestConfig{
				TriggerZScore:              settings.BacktestTriggerZScore,
				BaselineDays:               settings.BacktestBaselineDays,
				HoldoutDays:                holdoutDays,
				EvaluationTargetStartDayMs: holdoutStartDayMs,
				EvaluationTargetEndDayMs:   analyzedEndAtMs,
			}
			configJSON, err := json.Marshal(backtestConfig)
			if err != nil {
				return refreshResponse{}, err
			}

			status := "completed"
			var metricsJSON []byte
			if holdoutDays > 0 {
				metrics := RunBacktest(entry.candidate.series, targetReturns, AssociationRef{
					LagDays:     entry.best.LagDays,
					Correlation: entry.best.Correlation,
				}, backtestConfig)
				metricsJSON, err = json.Marshal(metrics)
			} else {
				// holdoutDays === 0：评估窗口 [endAt, endAt) 为空，运行回测会
				// 产生误导性的全零记录——显式记录跳过。
				status = "failed"
				metricsJSON, err = json.Marshal(skippedMetrics{
					Triggers:         0,
					EvaluatedSignals: 0,
					Hits:             0,
					HitRate:          0,
					Skipped:          "holdout_days_zero",
				})
			}
			if err != nil {
				return refreshResponse{}, err
			}

			pending = append(pending, pendingWrite{
				key: associationKey{
					orgID:           orgID,
					scopeType:       entry.candidate.scopeType,
					scopeKey:        entry.candidate.scopeKey,
					scopeKeyType:    entry.candidate.scopeKeyType,
					featureMetric:   entry.candidate.metric,
					indicatorItemID: indicator.id,
				},
				values: associationValues{
					windowDays:      settings.WindowDays,
					lagDays:         entry.best.LagDays,
					correlation:     entry.best.Correlation,
					pValue:          entry.best.PValue,
					sampleSize:      entry.best.SampleSize,
					analyzedStartAt: analyzedStartAt,
					analyzedEndAt:   analyzedEndAt,
					lastEvaluatedAt: evaluatedAt,
					metadata:        metadataJSON,
				},
				backtest: backtestData{
					status:      status,
					windowStart: holdoutStartAt,
					windowEnd:   analyzedEndAt,
					config:      configJSON,
					metrics:     metricsJSON,
				},
			})
		}
	}

	associationsUpserted := 0
	backtestsCreated := 0
	for _, chunk := range chunkArray(pending, associationChunkSize) {
		upserted, created, err := writeChunk(ctx, conn, chunk)
		if err != nil {
			return refreshResponse{}, err
		}
		associationsUpserted += upserted
		backtestsCreated += created
	}

	return refreshResponse{
		Indicators:           len(indicators),
		AssociationsUpserted: associationsUpserted,
		BacktestsCreated:     backtestsCreated,
	}, nil
}

// writeChunk 把一个 chunk 的 upsert、过期回测清理（where 带 orgId）与新
// 回测插入放在同一个数据库事务里。
func writeChunk(ctx context.Context, conn *sql.Conn, chunk []pendingWrite) (int, int, error) {
	if len(chunk) == 0 {
		return 0, 0, nil
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	ids := make([]string, 0, len(chunk))
	for _, write := range chunk {
		id, err := upsertAssociation(ctx, tx, write)
		if err != nil {
			return 0, 0, err
		}
		ids = append(ids, id)
	}

	retentionCutoff := nowMillis().Add(-backtestRetentionDays * 24 * time.Hour)
	deleteArgs := make([]any, 0, len(ids)+2)
	deleteArgs = append(deleteArgs, chunk[0].key.orgID)
	for _, id := range ids {
		deleteArgs = append(deleteArgs, id)
	}
	deleteArgs = append(deleteArgs, retentionCutoff)
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM NewsIndicatorAssociationBacktestRun WHERE orgId = ? AND associationId IN ("+
			placeholders(len(ids))+") AND createdAt < ?", deleteArgs...); err != nil {
		return 0, 0, err
	}

	for index, id := range ids {
		backtestID, err := newRowID()
		if err != nil {
			return 0, 0, err
		}
		now := nowMillis()
		write := chunk[index]
		if _, err := tx.ExecContext(ctx, `
INSERT INTO NewsIndicatorAssociationBacktestRun (id, orgId, associationId, status, windowStart, windowEnd, config, metrics, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			backtestID, write.key.orgID, id, write.backtest.status,
			write.backtest.windowStart, write.backtest.windowEnd,
			write.backtest.config, write.backtest.metrics, now, now); err != nil {
			return 0, 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	committed = true
	return len(ids), len(ids), nil
}

func upsertAssociation(ctx context.Context, tx *sql.Tx, write pendingWrite) (string, error) {
	key := write.key
	var id string
	err := tx.QueryRowContext(ctx,
		"SELECT id FROM NewsIndicatorAssociation WHERE orgId = ? AND scopeType = ? AND scopeKey = ? AND scopeKeyType = ? AND featureMetric = ? AND indicatorItemId = ? LIMIT 1",
		key.orgID, key.scopeType, key.scopeKey, key.scopeKeyType, key.featureMetric, key.indicatorItemID,
	).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		newID, err := newRowID()
		if err != nil {
			return "", err
		}
		now := nowMillis()
		if _, err := tx.ExecContext(ctx, `
INSERT INTO NewsIndicatorAssociation (id, orgId, scopeType, scopeKey, scopeKeyType, featureMetric, indicatorItemId, windowDays, lagDays, correlation, pValue, sampleSize, analyzedStartAt, analyzedEndAt, metadata, lastEvaluatedAt, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			newID, key.orgID, key.scopeType, key.scopeKey, key.scopeKeyType, key.featureMetric, key.indicatorItemID,
			write.values.windowDays, write.values.lagDays, write.values.correlation, write.values.pValue,
			write.values.sampleSize, write.values.analyzedStartAt, write.values.analyzedEndAt,
			write.values.metadata, write.values.lastEvaluatedAt, now, now); err != nil {
			return "", err
		}
		return newID, nil
	}
	if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE NewsIndicatorAssociation
SET windowDays = ?, lagDays = ?, correlation = ?, pValue = ?, sampleSize = ?, analyzedStartAt = ?, analyzedEndAt = ?, lastEvaluatedAt = ?, metadata = ?, updatedAt = ?
WHERE id = ?`,
		write.values.windowDays, write.values.lagDays, write.values.correlation, write.values.pValue,
		write.values.sampleSize, write.values.analyzedStartAt, write.values.analyzedEndAt,
		write.values.lastEvaluatedAt, write.values.metadata, nowMillis(), id); err != nil {
		return "", err
	}
	return id, nil
}

func loadActiveIndicators(ctx context.Context, q queryer, slugs []string) ([]indicatorKey, error) {
	if len(slugs) == 0 {
		return nil, nil
	}
	args := make([]any, 0, len(slugs))
	for _, slug := range slugs {
		args = append(args, slug)
	}
	rows, err := q.QueryContext(ctx,
		"SELECT id, slug FROM EconomicDataItem WHERE slug IN ("+placeholders(len(slugs))+") AND isActive = 1", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []indicatorKey{}
	for rows.Next() {
		var item indicatorKey
		if err := rows.Scan(&item.id, &item.slug); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func loadTopEntityKeys(ctx context.Context, q queryer, orgID string, since time.Time, limit int) ([]entityKey, error) {
	take := clampIntTrunc(limit, 0, 500)
	if take == 0 {
		return nil, nil
	}
	rows, err := q.QueryContext(ctx, `
SELECT entityName, entityType
FROM EntitySentimentSnapshot
WHERE orgId = ? AND bucketStart >= ?
GROUP BY entityName, entityType
ORDER BY SUM(totalDocs) DESC
LIMIT ?`, orgID, since, take)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []entityKey{}
	for rows.Next() {
		var key entityKey
		if err := rows.Scan(&key.name, &key.kind); err != nil {
			return nil, err
		}
		if len(key.name) == 0 {
			continue
		}
		out = append(out, key)
	}
	return out, rows.Err()
}

func loadTopTopicKeys(ctx context.Context, q queryer, orgID string, since time.Time, limit int) ([]string, error) {
	take := clampIntTrunc(limit, 0, 500)
	if take == 0 {
		return nil, nil
	}
	rows, err := q.QueryContext(ctx, `
SELECT topic
FROM TopicSentimentSnapshot
WHERE orgId = ? AND bucketStart >= ?
GROUP BY topic
ORDER BY SUM(totalDocs) DESC
LIMIT ?`, orgID, since, take)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var topic string
		if err := rows.Scan(&topic); err != nil {
			return nil, err
		}
		if len(topic) == 0 {
			continue
		}
		out = append(out, topic)
	}
	return out, rows.Err()
}

func loadEntityFeatureSeries(ctx context.Context, q queryer, orgID string, since time.Time, keys []entityKey) (*featureSeries, error) {
	series := newFeatureSeries()
	if len(keys) == 0 {
		return series, nil
	}
	clauses := make([]string, 0, len(keys))
	args := []any{orgID, since}
	for _, key := range keys {
		clauses = append(clauses, "(entityName = ? AND entityType = ?)")
		args = append(args, key.name, key.kind)
	}
	rows, err := q.QueryContext(ctx,
		"SELECT entityName, entityType, bucketStart, totalDocs, avgScore, negativeRatio FROM EntitySentimentSnapshot"+
			" WHERE orgId = ? AND bucketStart >= ? AND ("+strings.Join(clauses, " OR ")+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var name, kind string
		var bucketStart time.Time
		var data featureRow
		if err := rows.Scan(&name, &kind, &bucketStart, &data.totalDocs, &data.avgScore, &data.negativeRatio); err != nil {
			return nil, err
		}
		key := name + "::" + kind
		bucket := ToUtcDayStartMs(bucketStart)
		for _, metric := range metricsToEvaluate {
			series.set(key, metric, bucket, resolveFeatureValue(data, metric))
		}
	}
	return series, rows.Err()
}

func loadTopicFeatureSeries(ctx context.Context, q queryer, orgID string, since time.Time, topics []string) (*featureSeries, error) {
	series := newFeatureSeries()
	if len(topics) == 0 {
		return series, nil
	}
	args := make([]any, 0, len(topics)+2)
	args = append(args, orgID, since)
	for _, topic := range topics {
		args = append(args, topic)
	}
	rows, err := q.QueryContext(ctx,
		"SELECT topic, bucketStart, totalDocs, avgScore, negativeRatio FROM TopicSentimentSnapshot"+
			" WHERE orgId = ? AND bucketStart >= ? AND topic IN ("+placeholders(len(topics))+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var topic string
		var bucketStart time.Time
		var data featureRow
		if err := rows.Scan(&topic, &bucketStart, &data.totalDocs, &data.avgScore, &data.negativeRatio); err != nil {
			return nil, err
		}
		bucket := ToUtcDayStartMs(bucketStart)
		for _, metric := range metricsToEvaluate {
			series.set(topic, metric, bucket, resolveFeatureValue(data, metric))
		}
	}
	return series, rows.Err()
}

func loadIndicatorPointsByItem(ctx context.Context, q queryer, itemIDs []string, startAt, endAt time.Time) (map[string][]NumericSeriesPoint, error) {
	out := map[string][]NumericSeriesPoint{}
	if len(itemIDs) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(itemIDs)+2)
	for _, id := range itemIDs {
		args = append(args, id)
	}
	args = append(args, startAt, endAt)
	rows, err := q.QueryContext(ctx,
		"SELECT id, itemId, recordedAt, value FROM EconomicDataPoint"+
			" WHERE itemId IN ("+placeholders(len(itemIDs))+") AND recordedAt >= ? AND recordedAt <= ?"+
			" ORDER BY itemId ASC, recordedAt ASC, id ASC", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, itemID, rawValue string
		var recordedAt time.Time
		if err := rows.Scan(&id, &itemID, &recordedAt, &rawValue); err != nil {
			return nil, err
		}
		existing := out[itemID]
		if len(existing) >= maxPointsPerIndicator {
			continue
		}
		out[itemID] = append(existing, NumericSeriesPoint{
			ID:         id,
			RecordedAt: recordedAt,
			Value:      parseFloatValue(rawValue),
		})
	}
	return out, rows.Err()
}

func resolveFeatureValue(row featureRow, metric string) float64 {
	switch metric {
	case "avg_score":
		return row.avgScore
	case "negative_ratio":
		return row.negativeRatio
	default:
		return float64(row.totalDocs)
	}
}

// parseFloatValue 与 TS Number(row.value) 语义一致：无法解析返回 NaN，
// 由 buildDailyEconomicValues 跳过。
func parseFloatValue(raw string) float64 {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return math.NaN()
	}
	return parsed
}

func splitEntityKey(key string) (string, string) {
	parts := strings.SplitN(key, "::", 2)
	if len(parts) == 0 {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], parts[1]
}

func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func chunkArray[T any](items []T, size int) [][]T {
	if size <= 0 {
		return [][]T{items}
	}
	chunks := make([][]T, 0, (len(items)+size-1)/size)
	for index := 0; index < len(items); index += size {
		end := index + size
		if end > len(items) {
			end = len(items)
		}
		chunks = append(chunks, items[index:end])
	}
	return chunks
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// AuthenticateMachine 与 newssources/crawltemplate 相同：SHA-256 十六进制查
// MachineAccessToken.tokenHash，连 Org.isActive；查不到、已撤销、已过期、
// 组织停用 → 401 Invalid machine token；查到更新 lastUsedAt。权限只解析
// 令牌行 permissions JSON 里的字符串数组；orgId 只用令牌行的。
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var permissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := s.db.QueryRowContext(ctx, `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&id, &orgID, &permissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatus(401, "Invalid machine token")
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, newStatus(401, "Invalid machine token")
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`, nowMillis(), id)
	return authhttp.NewIdentity("machine:"+id, orgID, permissionList(permissions)), nil
}

func permissionList(raw []byte) []string {
	var parsed []any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil
	}
	out := make([]string, 0, len(parsed))
	for _, item := range parsed {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}
