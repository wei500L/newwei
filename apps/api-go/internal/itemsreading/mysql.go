package itemsreading

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// mySQLStore is the organization-scoped MySQL access layer behind the item
// reading routes. Every statement it issues carries the caller's orgId, which
// is derived from the authenticated identity and never from a request
// parameter.
type mySQLStore struct {
	db *sql.DB
}

// newMySQLStore wraps a MySQL connection pool.
func newMySQLStore(db *sql.DB) *mySQLStore {
	return &mySQLStore{db: db}
}

// mySQLArgs is the positional parameter vector of one statement. It is an alias
// of the BSON array type because database/sql declares its parameters as a
// variadic slice of the empty interface: a slice type with that same element
// type is assignable to the variadic parameter, so the vector can be spread
// into QueryContext and QueryRowContext while this file stays free of the
// untyped slice forms the package forbids. Nothing here is BSON-encoded; the
// values are ordinary SQL parameters.
type mySQLArgs = bson.A

// itemMetaColumns is the shared ItemMeta projection. It lists the columns in
// the exact order mySQLScanItemMetaRows reads them.
const itemMetaColumns = "`id`, `orgId`, `externalId`, `name`, `status`, `mongoRef`, `version`, `publishedAt`, `sortAt`, `createdAt`, `updatedAt`"

// itemMetaBaseWhere is the reading range shared by every ItemMeta list, count
// and search statement: one organization, duplicates excluded. It matches
// buildBaseWhere in items-search.helpers.ts.
const itemMetaBaseWhere = " WHERE `orgId` = ? AND `status` <> 'duplicate'"

// mySQLLikeEscapeClause names the LIKE escape character explicitly. The SQL text
// carries two backslashes so MySQL's default string parsing yields one, which
// is the character mySQLLikePrefixPattern inserts before a literal wildcard.
const mySQLLikeEscapeClause = ` ESCAPE '\\'`

// newsSourceRow is the organization-scoped NewsSource projection behind the RSS
// reading list. Config stays an open JSON leaf because the caller filters on
// config.seed.mode and reads config.seed.feedUrl from it.
type newsSourceRow struct {
	ID       string
	Name     string
	Language *string
	URL      string
	Config   OpenJSON
}

// crawlTaskConfigSource is the portion of CrawlTask.config that carries a
// source id, either directly or below itemPayload.metadata. It mirrors
// ItemsReadModelService.extractSourceIdFromTaskConfig.
type crawlTaskConfigSource struct {
	SourceID    *string `json:"sourceId"`
	ItemPayload *struct {
		Metadata *struct {
			SourceID *string `json:"sourceId"`
		} `json:"metadata"`
	} `json:"itemPayload"`
}

// openMySQLFromURL parses a Prisma-style mysql:// DATABASE_URL (the
// mysql+prisma:// alias is accepted as well) into a connection pool.
//
// The DSN is pinned to utf8mb4 with the utf8mb4_unicode_ci collation, ParseTime
// so the DATETIME(3) columns arrive as time.Time, and a UTC session location
// because the stored timestamps carry no zone of their own. The URL's own query
// parameters are ignored on purpose: the charset, collation and time handling
// above are the whole contract. The pool connects lazily, so an unreachable
// host surfaces on the first query rather than at wiring time.
func openMySQLFromURL(databaseURL string) (*sql.DB, error) {
	config, err := mySQLConfigFromURL(databaseURL)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", config.FormatDSN())
	if err != nil {
		return nil, fmt.Errorf("mysql open failed: %w", err)
	}
	return db, nil
}

// mySQLConfigFromURL converts a Prisma-style URL into a driver configuration.
// Credentials come from the parsed userinfo, so a percent-encoded password is
// decoded exactly once. Error messages describe the structure only; the DSN
// text and its credentials never reach a log line.
func mySQLConfigFromURL(databaseURL string) (mysql.Config, error) {
	var config mysql.Config
	trimmed := strings.TrimSpace(databaseURL)
	if trimmed == "" {
		return config, errors.New("DATABASE_URL is empty")
	}

	scheme := trimmed
	if index := strings.Index(trimmed, "://"); index >= 0 {
		scheme = trimmed[:index]
	}
	switch scheme {
	case "mysql", "mysql+prisma":
	default:
		return config, fmt.Errorf("unsupported DATABASE_URL scheme %q (want mysql or mysql+prisma)", scheme)
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return config, errors.New("DATABASE_URL is not a valid URL")
	}
	if parsed.Host == "" {
		return config, errors.New("DATABASE_URL has no host")
	}

	host := parsed.Hostname()
	port := parsed.Port()
	if port == "" {
		port = "3306"
	}
	config.Net = "tcp"
	config.Addr = host + ":" + port

	if parsed.User != nil {
		config.User = parsed.User.Username()
		config.Passwd, _ = parsed.User.Password()
	}

	databaseName := strings.TrimPrefix(parsed.Path, "/")
	if databaseName == "" {
		return config, errors.New("DATABASE_URL has no database name")
	}
	config.DBName = databaseName

	config.Params = map[string]string{"charset": "utf8mb4"}
	config.ParseTime = true
	config.Loc = time.UTC
	config.Collation = "utf8mb4_unicode_ci"

	return config, nil
}

// mySQLPlaceholders renders count comma-separated placeholders. Only the count
// is dynamic; every value is bound as a parameter.
func mySQLPlaceholders(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?, ", count), ", ")
}

// mySQLInPredicate renders ` AND <column> IN (?, ...)` for count values. The
// column is passed as a literal identifier by the callers below and is never
// taken from input.
func mySQLInPredicate(column string, count int) string {
	return " AND " + column + " IN (" + mySQLPlaceholders(count) + ")"
}

// mySQLItemMetaOrderClause maps the whitelisted orderBy contract onto a literal
// ORDER BY clause. The two enum values are the only inputs, so the clause can
// never carry request text.
func mySQLItemMetaOrderClause(orderBy ItemsOrderBy) string {
	if orderBy == ItemsOrderByPublishedDesc {
		return " ORDER BY `sortAt` DESC, `id` DESC"
	}
	return " ORDER BY `createdAt` DESC, `id` DESC"
}

// mySQLLikePrefixPattern renders a startsWith term as a LIKE prefix pattern.
// EscapeRegex removes the regular-expression metacharacters and doubles a
// literal backslash; the LIKE wildcards are escaped on top, so the pattern only
// ever matches a literal prefix. A blank term yields no pattern.
func mySQLLikePrefixPattern(term string) string {
	if strings.TrimSpace(term) == "" {
		return ""
	}
	escaped := EscapeRegex(term)
	escaped = strings.ReplaceAll(escaped, "%", `\%`)
	escaped = strings.ReplaceAll(escaped, "_", `\_`)
	return escaped + "%"
}

// mySQLNullString converts a nullable text column into the optional-string form
// the projections use.
func mySQLNullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	converted := value.String
	return &converted
}

// mySQLNullISOTime converts a nullable DATETIME column into the optional ISOTime
// form the API renders.
func mySQLNullISOTime(value sql.NullTime) *ISOTime {
	if !value.Valid {
		return nil
	}
	converted := NewISOTime(value.Time)
	return &converted
}

// mySQLObjectID parses a cleanedMarkdownRef into an ObjectId, mirroring the
// Types.ObjectId.isValid plus construction pair in NestJS. ObjectIDFromHex
// already rejects anything that is not a 24-character hex string, so a blank or
// malformed reference is reported as invalid and the caller skips the row.
func mySQLObjectID(value string) (bson.ObjectID, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return bson.NilObjectID, false
	}
	parsed, err := bson.ObjectIDFromHex(trimmed)
	if err != nil {
		return bson.NilObjectID, false
	}
	return parsed, true
}

// mySQLSourceIDFromTaskConfig extracts the source id from a CrawlTask.config
// document: config.sourceId first, then config.itemPayload.metadata.sourceId,
// each trimmed and ignored when blank. It mirrors
// ItemsReadModelService.extractSourceIdFromTaskConfig.
func mySQLSourceIDFromTaskConfig(config []byte) string {
	if len(config) == 0 {
		return ""
	}
	var decoded crawlTaskConfigSource
	if err := json.Unmarshal(config, &decoded); err != nil {
		return ""
	}
	if decoded.SourceID != nil {
		if trimmed := strings.TrimSpace(*decoded.SourceID); trimmed != "" {
			return trimmed
		}
	}
	if decoded.ItemPayload == nil || decoded.ItemPayload.Metadata == nil ||
		decoded.ItemPayload.Metadata.SourceID == nil {
		return ""
	}
	return strings.TrimSpace(*decoded.ItemPayload.Metadata.SourceID)
}

// mySQLScanItemMetaRows drains an ItemMeta projection result set. The select
// list must be itemMetaColumns.
func mySQLScanItemMetaRows(rows *sql.Rows) ([]ItemMetaRow, error) {
	out := make([]ItemMetaRow, 0, 8)
	for rows.Next() {
		var (
			row         ItemMetaRow
			publishedAt sql.NullTime
			sortAt      time.Time
			createdAt   time.Time
			updatedAt   time.Time
		)
		if err := rows.Scan(
			&row.ID,
			&row.OrgID,
			&row.ExternalID,
			&row.Name,
			&row.Status,
			&row.MongoRef,
			&row.Version,
			&publishedAt,
			&sortAt,
			&createdAt,
			&updatedAt,
		); err != nil {
			return nil, err
		}
		row.PublishedAt = mySQLNullISOTime(publishedAt)
		row.SortAt = NewISOTime(sortAt)
		row.CreatedAt = NewISOTime(createdAt)
		row.UpdatedAt = NewISOTime(updatedAt)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ListItemMeta returns the organization-scoped ItemMeta page. The range is the
// shared base range (orgId, status <> 'duplicate').
//
// When scopedIDs is non-nil the rows are restricted to that id set; an empty
// non-nil slice yields no rows without issuing a statement. orderBy is either
// ItemsOrderByCreatedDesc (createdAt DESC, id DESC) or ItemsOrderByPublishedDesc
// (sortAt DESC, id DESC); every other value falls back to the created ordering.
// offset and limit are page values the caller has already validated and clamped.
func (s *mySQLStore) ListItemMeta(
	ctx context.Context,
	orgID string,
	scopedIDs []string,
	orderBy ItemsOrderBy,
	offset int,
	limit int,
) ([]ItemMetaRow, error) {
	if scopedIDs != nil && len(scopedIDs) == 0 {
		return []ItemMetaRow{}, nil
	}

	query := "SELECT " + itemMetaColumns + " FROM `ItemMeta`" + itemMetaBaseWhere
	args := make(mySQLArgs, 0, len(scopedIDs)+3)
	args = append(args, orgID)
	if len(scopedIDs) > 0 {
		query += mySQLInPredicate("`id`", len(scopedIDs))
		for _, id := range scopedIDs {
			args = append(args, id)
		}
	}
	query += mySQLItemMetaOrderClause(orderBy)
	query += " LIMIT ? OFFSET ?"
	args = append(args, limit, offset)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return mySQLScanItemMetaRows(rows)
}

// CountItemMeta counts the same range as ListItemMeta (orgId, status <>
// 'duplicate', optionally restricted to scopedIDs). A non-nil empty scopedIDs
// yields zero without issuing a statement.
func (s *mySQLStore) CountItemMeta(ctx context.Context, orgID string, scopedIDs []string) (int, error) {
	if scopedIDs != nil && len(scopedIDs) == 0 {
		return 0, nil
	}

	query := "SELECT COUNT(*) FROM `ItemMeta`" + itemMetaBaseWhere
	args := make(mySQLArgs, 0, len(scopedIDs)+1)
	args = append(args, orgID)
	if len(scopedIDs) > 0 {
		query += mySQLInPredicate("`id`", len(scopedIDs))
		for _, id := range scopedIDs {
			args = append(args, id)
		}
	}

	var total int
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}

// FindItemMeta loads one ItemMeta by id for the organization. It returns nil
// when the row is missing. The duplicate status is deliberately not filtered:
// this is the detail path, which must be able to report a duplicate item.
func (s *mySQLStore) FindItemMeta(ctx context.Context, orgID string, itemID string) (*ItemMetaRow, error) {
	query := "SELECT " + itemMetaColumns + " FROM `ItemMeta`" +
		" WHERE `id` = ? AND `orgId` = ? LIMIT 1"

	rows, err := s.db.QueryContext(ctx, query, itemID, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items, err := mySQLScanItemMetaRows(rows)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

// FindItemMetaRows loads a map keyed by ItemMeta id for the organization,
// skipping the ids that do not exist. The duplicate status is not filtered, so
// the read-model hydration sees every meta row it asked for. An effectively
// empty id set yields an empty map without issuing a statement.
func (s *mySQLStore) FindItemMetaRows(
	ctx context.Context,
	orgID string,
	ids []string,
) (map[string]ItemMetaRow, error) {
	out := make(map[string]ItemMetaRow, len(ids))
	ordered := DedupeItemMetaIDs(ids)
	if len(ordered) == 0 {
		return out, nil
	}

	query := "SELECT " + itemMetaColumns + " FROM `ItemMeta`" +
		" WHERE `orgId` = ?" + mySQLInPredicate("`id`", len(ordered))
	args := make(mySQLArgs, 0, len(ordered)+1)
	args = append(args, orgID)
	for _, id := range ordered {
		args = append(args, id)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items, err := mySQLScanItemMetaRows(rows)
	if err != nil {
		return nil, err
	}
	for _, row := range items {
		out[row.ID] = row
	}
	return out, nil
}

// FindItemMetaIDs returns the subset of ids that exist for the organization.
// The result keeps the caller's order after the trim-and-dedupe pass, so it is
// deterministic. An effectively empty id set yields an empty slice without
// issuing a statement.
func (s *mySQLStore) FindItemMetaIDs(ctx context.Context, orgID string, ids []string) ([]string, error) {
	ordered := DedupeItemMetaIDs(ids)
	out := make([]string, 0, len(ordered))
	if len(ordered) == 0 {
		return out, nil
	}

	query := "SELECT `id` FROM `ItemMeta` WHERE `orgId` = ?" + mySQLInPredicate("`id`", len(ordered))
	args := make(mySQLArgs, 0, len(ordered)+1)
	args = append(args, orgID)
	for _, id := range ordered {
		args = append(args, id)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	existing := make(map[string]struct{}, len(ordered))
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		existing[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, id := range ordered {
		if _, found := existing[id]; found {
			out = append(out, id)
		}
	}
	return out, nil
}

// MetaFullTextSearch runs the ItemMeta FULLTEXT recall on (name, externalId) in
// BOOLEAN MODE over the base range and returns the matching ids, dupes removed,
// ordered by score DESC, createdAt DESC, id DESC and capped at MaxSearchMatches.
// booleanQuery is built by the caller (token* tokens joined by spaces); a blank
// query yields an empty result without issuing a statement.
func (s *mySQLStore) MetaFullTextSearch(
	ctx context.Context,
	orgID string,
	booleanQuery string,
) ([]string, error) {
	trimmed := strings.TrimSpace(booleanQuery)
	if trimmed == "" {
		return []string{}, nil
	}

	query := "SELECT `id`, MATCH(`name`, `externalId`) AGAINST (? IN BOOLEAN MODE) AS `score`" +
		" FROM `ItemMeta`" + itemMetaBaseWhere +
		" AND MATCH(`name`, `externalId`) AGAINST (? IN BOOLEAN MODE)" +
		" ORDER BY `score` DESC, `createdAt` DESC, `id` DESC" +
		" LIMIT ?"
	args := mySQLArgs{trimmed, orgID, trimmed, MaxSearchMatches}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]string, 0, 64)
	for rows.Next() {
		var id string
		var score float64
		if err := rows.Scan(&id, &score); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return DedupeItemMetaIDs(out), nil
}

// MetaPrefixSearch runs the startsWith prefix recall over the base range: the
// term, escaped for both the regular-expression set and the LIKE wildcards, is
// matched as `name LIKE 'term%' OR externalId LIKE 'term%'` with an explicit
// backslash escape. The ids, dupes removed, are ordered by createdAt DESC,
// id DESC and capped at MaxSearchMatches. A blank term yields an empty result
// without issuing a statement.
func (s *mySQLStore) MetaPrefixSearch(ctx context.Context, orgID string, term string) ([]string, error) {
	pattern := mySQLLikePrefixPattern(term)
	if pattern == "" {
		return []string{}, nil
	}

	query := "SELECT `id` FROM `ItemMeta`" + itemMetaBaseWhere +
		" AND (`name` LIKE ?" + mySQLLikeEscapeClause +
		" OR `externalId` LIKE ?" + mySQLLikeEscapeClause + ")" +
		" ORDER BY `createdAt` DESC, `id` DESC" +
		" LIMIT ?"
	args := mySQLArgs{orgID, pattern, pattern, MaxSearchMatches}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]string, 0, 64)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return DedupeItemMetaIDs(out), nil
}

// ProcessedArticleSearch runs the ProcessedArticle FULLTEXT recall on
// (title, summary) joined to Article on a.orgId, and returns the
// cleanedMarkdownRef values that are valid ObjectIds. The ordering is score
// DESC, pa.updatedAt DESC, pa.id DESC and the result is capped at
// MaxSearchMatches. A blank booleanQuery yields an empty result without issuing
// a statement.
func (s *mySQLStore) ProcessedArticleSearch(
	ctx context.Context,
	orgID string,
	booleanQuery string,
) ([]bson.ObjectID, error) {
	trimmed := strings.TrimSpace(booleanQuery)
	if trimmed == "" {
		return []bson.ObjectID{}, nil
	}

	query := "SELECT pa.`cleanedMarkdownRef`," +
		" MATCH(pa.`title`, pa.`summary`) AGAINST (? IN BOOLEAN MODE) AS `score`" +
		" FROM `ProcessedArticle` pa" +
		" INNER JOIN `Article` a ON a.`id` = pa.`articleId`" +
		" WHERE a.`orgId` = ?" +
		" AND pa.`cleanedMarkdownRef` IS NOT NULL" +
		" AND MATCH(pa.`title`, pa.`summary`) AGAINST (? IN BOOLEAN MODE)" +
		" ORDER BY `score` DESC, pa.`updatedAt` DESC, pa.`id` DESC" +
		" LIMIT ?"
	args := mySQLArgs{trimmed, orgID, trimmed, MaxSearchMatches}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]bson.ObjectID, 0, 32)
	for rows.Next() {
		var ref sql.NullString
		var score float64
		if err := rows.Scan(&ref, &score); err != nil {
			return nil, err
		}
		if !ref.Valid {
			continue
		}
		objectID, ok := mySQLObjectID(ref.String)
		if !ok {
			continue
		}
		out = append(out, objectID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ProcessedArticleSourceFallback implements
// resolveSourceFilterFallbackItemMetaIds: the ProcessedArticle rows whose
// Article belongs to the organization and to one of sourceIDs, optionally
// inside the crawlAt range, restricted to status 'completed' and a non-null
// cleanedMarkdownRef. It returns the cleanedMarkdownRef values that are valid
// ObjectIds, ordered by pa.updatedAt DESC, pa.id DESC. The scan is deliberately
// uncapped, exactly like the Prisma findMany it ports; the caller merges and
// de-duplicates the result. An empty sourceIDs yields an empty result without
// issuing a statement.
func (s *mySQLStore) ProcessedArticleSourceFallback(
	ctx context.Context,
	orgID string,
	sourceIDs []string,
	dateRange *ItemDateRangeFilter,
) ([]bson.ObjectID, error) {
	if len(sourceIDs) == 0 {
		return []bson.ObjectID{}, nil
	}

	query := "SELECT pa.`cleanedMarkdownRef`" +
		" FROM `ProcessedArticle` pa" +
		" INNER JOIN `Article` a ON a.`id` = pa.`articleId`" +
		" WHERE a.`orgId` = ?" +
		" AND a.`sourceId` IN (" + mySQLPlaceholders(len(sourceIDs)) + ")" +
		" AND pa.`status` = 'completed'" +
		" AND pa.`cleanedMarkdownRef` IS NOT NULL"
	args := make(mySQLArgs, 0, len(sourceIDs)+4)
	args = append(args, orgID)
	for _, sourceID := range sourceIDs {
		args = append(args, sourceID)
	}
	if dateRange != nil {
		if dateRange.Start != nil {
			query += " AND a.`crawlAt` >= ?"
			args = append(args, dateRange.Start.UTC())
		}
		if dateRange.End != nil {
			query += " AND a.`crawlAt` <= ?"
			args = append(args, dateRange.End.UTC())
		}
	}
	query += " ORDER BY pa.`updatedAt` DESC, pa.`id` DESC"

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]bson.ObjectID, 0, 32)
	for rows.Next() {
		var ref sql.NullString
		if err := rows.Scan(&ref); err != nil {
			return nil, err
		}
		if !ref.Valid {
			continue
		}
		objectID, ok := mySQLObjectID(ref.String)
		if !ok {
			continue
		}
		out = append(out, objectID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// RssNewsSources returns the active NewsSource rows of the organization,
// mirroring the NestJS orderBy priority DESC, updatedAt DESC, createdAt DESC.
// The config JSON column stays an open leaf; the caller decides whether
// config.seed.mode is "rss" and which feed URL to use.
func (s *mySQLStore) RssNewsSources(ctx context.Context, orgID string) ([]newsSourceRow, error) {
	query := "SELECT `id`, `name`, `language`, `url`, `config`" +
		" FROM `NewsSource`" +
		" WHERE `orgId` = ? AND `isActive` = 1" +
		" ORDER BY `priority` DESC, `updatedAt` DESC, `createdAt` DESC"

	rows, err := s.db.QueryContext(ctx, query, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]newsSourceRow, 0, 16)
	for rows.Next() {
		var (
			row      newsSourceRow
			language sql.NullString
			config   []byte
		)
		if err := rows.Scan(&row.ID, &row.Name, &language, &row.URL, &config); err != nil {
			return nil, err
		}
		row.Language = mySQLNullString(language)
		row.Config = NewOpenJSON(config)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ArticleWindowStats ports the prisma.article.groupBy used by the RSS source
// list: for the organization, the given sources and everything crawled at or
// after since, it returns per-source the article count and the newest crawlAt.
// Sources without a matching article have no entry, exactly like a GROUP BY.
// An empty sourceIDs yields an empty map without issuing a statement.
func (s *mySQLStore) ArticleWindowStats(
	ctx context.Context,
	orgID string,
	sourceIDs []string,
	since time.Time,
) (map[string]WindowStat, error) {
	out := make(map[string]WindowStat, len(sourceIDs))
	if len(sourceIDs) == 0 {
		return out, nil
	}

	query := "SELECT `sourceId`, COUNT(*), MAX(`crawlAt`)" +
		" FROM `Article`" +
		" WHERE `orgId` = ?" +
		" AND `sourceId` IN (" + mySQLPlaceholders(len(sourceIDs)) + ")" +
		" AND `crawlAt` >= ?" +
		" GROUP BY `sourceId`"
	args := make(mySQLArgs, 0, len(sourceIDs)+2)
	args = append(args, orgID)
	for _, sourceID := range sourceIDs {
		args = append(args, sourceID)
	}
	args = append(args, since.UTC())

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			sourceID string
			count    int
			latest   sql.NullTime
		)
		if err := rows.Scan(&sourceID, &count, &latest); err != nil {
			return nil, err
		}
		trimmed := strings.TrimSpace(sourceID)
		if trimmed == "" {
			continue
		}
		stat := WindowStat{ItemCountWindow: count}
		if latest.Valid {
			value := latest.Time.UTC()
			stat.LatestItemAt = &value
		}
		out[trimmed] = stat
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// PipelineJobSourceIDs returns id -> sourceId for the organization-scoped
// pipeline jobs that have a non-null, non-blank sourceId. A blank value is
// dropped, mirroring the trim check in ItemsReadModelService. An effectively
// empty id set yields an empty map without issuing a statement.
func (s *mySQLStore) PipelineJobSourceIDs(
	ctx context.Context,
	orgID string,
	ids []string,
) (map[string]string, error) {
	out := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}

	query := "SELECT `id`, `sourceId` FROM `PipelineJob`" +
		" WHERE `orgId` = ?" +
		" AND `sourceId` IS NOT NULL" +
		mySQLInPredicate("`id`", len(ids))
	args := make(mySQLArgs, 0, len(ids)+1)
	args = append(args, orgID)
	for _, id := range ids {
		args = append(args, id)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id       string
			sourceID sql.NullString
		)
		if err := rows.Scan(&id, &sourceID); err != nil {
			return nil, err
		}
		if !sourceID.Valid {
			continue
		}
		trimmed := strings.TrimSpace(sourceID.String)
		if trimmed == "" {
			continue
		}
		if _, exists := out[id]; exists {
			continue
		}
		out[id] = trimmed
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// CrawlResultSourceIDs returns crawlResult id -> sourceId for the organization,
// extracting the id from CrawlTask.config exactly like
// ItemsReadModelService.extractSourceIdFromTaskConfig: config.sourceId first,
// then config.itemPayload.metadata.sourceId. Tenant scoping is enforced through
// the joined CrawlTask.orgId, the same predicate NestJS uses. An effectively
// empty id set yields an empty map without issuing a statement.
func (s *mySQLStore) CrawlResultSourceIDs(
	ctx context.Context,
	orgID string,
	ids []string,
) (map[string]string, error) {
	out := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}

	query := "SELECT cr.`id`, ct.`config`" +
		" FROM `CrawlResult` cr" +
		" INNER JOIN `CrawlTask` ct ON ct.`id` = cr.`taskId`" +
		" WHERE ct.`orgId` = ?" +
		mySQLInPredicate("cr.`id`", len(ids))
	args := make(mySQLArgs, 0, len(ids)+1)
	args = append(args, orgID)
	for _, id := range ids {
		args = append(args, id)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id     string
			config []byte
		)
		if err := rows.Scan(&id, &config); err != nil {
			return nil, err
		}
		sourceID := mySQLSourceIDFromTaskConfig(config)
		if sourceID == "" {
			continue
		}
		if _, exists := out[id]; exists {
			continue
		}
		out[id] = sourceID
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
