package newsbehavior

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

// Collaborative profile. This ports getCollaborativeProfile and its similarity
// snapshot machinery from user-news-behavior.service.ts. The Redis profile,
// aggregate and snapshot tables are the same ones NestJS uses; the similarity
// lease is CacheService.withLock("user-news-behavior:similarity:<org>:<user>").

const (
	similarityNeighborLimit  = 50
	similarityCandidateLimit = 80
	similarityTopSignals     = 24
	similarityMinShared      = 3
	similaritySnapshotTTL    = 6 * time.Hour
	similarityLockTTL        = 30 * time.Second
	similarityChunkSize      = 200
	scoreKeepLimit           = 300
	collabEpsilon            = 0.0001
)

// SimilarityNeighbor is one stored neighbor.
type SimilarityNeighbor struct {
	UserID        string  `json:"userId"`
	Similarity    float64 `json:"similarity"`
	SharedSignals int     `json:"sharedSignals"`
}

// CollaborativeProfileView is the collaborative slice of the profile.
type CollaborativeProfileView struct {
	Sources    personalnews.ScoreMap
	Topics     personalnews.ScoreMap
	Entities   personalnews.ScoreMap
	Items      personalnews.ScoreMap
	Events     personalnews.ScoreMap
	Domains    personalnews.ScoreMap
	Neighbors  []SimilarityNeighbor
	Degraded   bool
	ComputedAt *string
}

// aggregateRow is one UserNewsBehaviorAggregate row.
type aggregateRow struct {
	UserID           string
	SignalType       string
	SignalKey        string
	Score            float64
	LastInteractedAt sql.NullTime
}

// similaritySnapshotRow is the UserNewsSimilaritySnapshot projection.
type similaritySnapshotRow struct {
	Dirty      bool
	ComputedAt sql.NullTime
	Neighbors  []byte
}

// GetCollaborativeProfile ports getCollaborativeProfile, including the degraded
// fallback to the previously stored neighbors.
func (s *Service) GetCollaborativeProfile(ctx context.Context, orgID, userID string) (CollaborativeProfileView, error) {
	if s == nil || s.db == nil {
		return CollaborativeProfileView{}, fmt.Errorf("%w: database is not configured", errDB)
	}
	snapshot, err := s.getSimilaritySnapshot(ctx, orgID, userID)
	if err != nil {
		return CollaborativeProfileView{}, err
	}
	empty := CollaborativeProfileView{
		Sources:    personalnews.ScoreMap{},
		Topics:     personalnews.ScoreMap{},
		Entities:   personalnews.ScoreMap{},
		Items:      personalnews.ScoreMap{},
		Events:     personalnews.ScoreMap{},
		Domains:    personalnews.ScoreMap{},
		Neighbors:  snapshot.Neighbors,
		Degraded:   snapshot.Degraded,
		ComputedAt: snapshot.ComputedAt,
	}
	if len(snapshot.Neighbors) == 0 {
		return empty, nil
	}
	neighborIDs := make([]string, 0, len(snapshot.Neighbors))
	similarityByUser := make(map[string]float64, len(snapshot.Neighbors))
	for _, neighbor := range snapshot.Neighbors {
		if neighbor.Similarity <= 0 {
			continue
		}
		neighborIDs = append(neighborIDs, neighbor.UserID)
		similarityByUser[neighbor.UserID] = neighbor.Similarity
	}
	if len(neighborIDs) == 0 {
		return empty, nil
	}
	rows, err := s.selectAggregatesForUsers(ctx, orgID, neighborIDs)
	if err != nil {
		return CollaborativeProfileView{}, err
	}
	sources := newTally()
	topics := newTally()
	entities := newTally()
	items := newTally()
	events := newTally()
	domains := newTally()
	now := time.Now().UTC()
	for _, row := range rows {
		similarity := similarityByUser[row.UserID]
		if similarity <= 0 || row.Score <= 0 {
			continue
		}
		dimension, ok := signalTypeDimension(row.SignalType)
		if !ok {
			continue
		}
		decayed := toDecayedScore(row.Score, row.LastInteractedAt, now)
		if decayed <= 0 {
			continue
		}
		target := tallyForDimension(dimension, sources, topics, entities, items, events, domains)
		if target == nil {
			continue
		}
		target.add(row.SignalKey, round4(decayed*similarity))
	}
	return CollaborativeProfileView{
		Sources:    limitScoreRecord(sources),
		Topics:     limitScoreRecord(topics),
		Entities:   limitScoreRecord(entities),
		Items:      limitScoreRecord(items),
		Events:     limitScoreRecord(events),
		Domains:    limitScoreRecord(domains),
		Neighbors:  snapshot.Neighbors,
		Degraded:   snapshot.Degraded,
		ComputedAt: snapshot.ComputedAt,
	}, nil
}

// tallyForDimension picks the dimension account.
func tallyForDimension(dimension string, sources, topics, entities, items, events, domains *tally) *tally {
	switch dimension {
	case "sources":
		return sources
	case "topics":
		return topics
	case "entities":
		return entities
	case "items":
		return items
	case "events":
		return events
	case "domains":
		return domains
	default:
		return nil
	}
}

// limitScoreRecord sorts by score descending and keeps the first 300 entries.
func limitScoreRecord(values *tally) personalnews.ScoreMap {
	out := make(personalnews.ScoreMap, len(values.keys))
	type pair struct {
		key   string
		value float64
	}
	pairs := make([]pair, 0, len(values.keys))
	for _, key := range values.keys {
		pairs = append(pairs, pair{key: key, value: values.vals[key]})
	}
	sort.SliceStable(pairs, func(left, right int) bool { return pairs[left].value > pairs[right].value })
	if len(pairs) > scoreKeepLimit {
		pairs = pairs[:scoreKeepLimit]
	}
	for _, entry := range pairs {
		out[entry.key] = entry.value
	}
	return out
}

// snapshotResult is the getSimilaritySnapshot return.
type snapshotResult struct {
	Neighbors  []SimilarityNeighbor
	Degraded   bool
	ComputedAt *string
}

// getSimilaritySnapshot ports getSimilaritySnapshot.
func (s *Service) getSimilaritySnapshot(ctx context.Context, orgID, userID string) (snapshotResult, error) {
	if err := s.ensurePersistentAggregateBackfill(ctx, orgID, userID); err != nil {
		return snapshotResult{}, err
	}
	existing, err := s.selectSimilaritySnapshot(ctx, orgID, userID)
	if err != nil {
		return snapshotResult{}, err
	}
	if existing != nil && isSimilaritySnapshotFresh(*existing, time.Now().UTC()) {
		return snapshotResult{
			Neighbors:  parseSimilarityNeighbors(existing.Neighbors),
			Degraded:   false,
			ComputedAt: isoTimePtr(existing.ComputedAt),
		}, nil
	}
	refreshed, refreshErr := s.refreshSimilaritySnapshot(ctx, orgID, userID)
	if refreshErr == nil {
		computedAt := isoTimeValue(refreshed.ComputedAt)
		return snapshotResult{
			Neighbors:  refreshed.Neighbors,
			Degraded:   false,
			ComputedAt: &computedAt,
		}, nil
	}
	var neighbors []SimilarityNeighbor
	var computedAt *string
	if existing != nil {
		neighbors = parseSimilarityNeighbors(existing.Neighbors)
		computedAt = isoTimePtr(existing.ComputedAt)
	}
	return snapshotResult{Neighbors: neighbors, Degraded: true, ComputedAt: computedAt}, nil
}

// isSimilaritySnapshotFresh mirrors isSimilaritySnapshotFresh.
func isSimilaritySnapshotFresh(snapshot similaritySnapshotRow, now time.Time) bool {
	if snapshot.Dirty || !snapshot.ComputedAt.Valid {
		return false
	}
	return now.Sub(snapshot.ComputedAt.Time) <= similaritySnapshotTTL
}

// similarityRefresh is the refreshSimilaritySnapshot return.
type similarityRefresh struct {
	Neighbors  []SimilarityNeighbor
	ComputedAt time.Time
}

// refreshSimilaritySnapshot ports refreshSimilaritySnapshot: compute under the
// lease and persist; on contention reuse a fresh snapshot or recompute without
// persisting.
func (s *Service) refreshSimilaritySnapshot(ctx context.Context, orgID, userID string) (similarityRefresh, error) {
	type refreshed struct {
		Neighbors  []SimilarityNeighbor
		ComputedAt string
	}
	var result refreshed
	acquired, err := s.withSimilarityLock(ctx, orgID, userID, func() error {
		targetRows, err := s.selectAggregatesForUser(ctx, orgID, userID)
		if err != nil {
			return err
		}
		neighbors, err := s.computeSimilarityNeighbors(ctx, orgID, userID, targetRows)
		if err != nil {
			return err
		}
		computedAt := time.Now().UTC().Truncate(time.Millisecond)
		if err := s.upsertSimilaritySnapshot(ctx, orgID, userID, neighbors, computedAt); err != nil {
			return err
		}
		result.Neighbors = neighbors
		result.ComputedAt = isoTimeValue(computedAt)
		return nil
	})
	if err != nil {
		return similarityRefresh{}, err
	}
	if acquired {
		return similarityRefresh{
			Neighbors:  result.Neighbors,
			ComputedAt: parseISOTimeValue(result.ComputedAt),
		}, nil
	}
	snapshot, err := s.selectSimilaritySnapshot(ctx, orgID, userID)
	if err != nil {
		return similarityRefresh{}, err
	}
	if snapshot != nil && isSimilaritySnapshotFresh(*snapshot, time.Now().UTC()) {
		computedAt := time.Now().UTC()
		if snapshot.ComputedAt.Valid {
			computedAt = snapshot.ComputedAt.Time
		}
		return similarityRefresh{
			Neighbors:  parseSimilarityNeighbors(snapshot.Neighbors),
			ComputedAt: computedAt,
		}, nil
	}
	targetRows, err := s.selectAggregatesForUser(ctx, orgID, userID)
	if err != nil {
		return similarityRefresh{}, err
	}
	neighbors, err := s.computeSimilarityNeighbors(ctx, orgID, userID, targetRows)
	if err != nil {
		return similarityRefresh{}, err
	}
	return similarityRefresh{Neighbors: neighbors, ComputedAt: time.Now().UTC()}, nil
}

// computeSimilarityNeighbors ports computeSimilarityNeighbors.
func (s *Service) computeSimilarityNeighbors(ctx context.Context, orgID, userID string, targetRows []aggregateRow) ([]SimilarityNeighbor, error) {
	now := time.Now().UTC()
	targetVector := make(map[string]float64, len(targetRows))
	targetNorm := 0.0
	for _, row := range targetRows {
		weighted := toDecayedScore(row.Score, row.LastInteractedAt, now)
		if math.Abs(weighted) <= collabEpsilon {
			continue
		}
		key := row.SignalType + ":" + row.SignalKey
		targetVector[key] = weighted
		targetNorm += weighted * weighted
	}
	if len(targetVector) == 0 || targetNorm <= 0 {
		return []SimilarityNeighbor{}, nil
	}
	keys := make([]string, 0, len(targetVector))
	for key := range targetVector {
		keys = append(keys, key)
	}
	sort.SliceStable(keys, func(left, right int) bool {
		return math.Abs(targetVector[keys[left]]) > math.Abs(targetVector[keys[right]])
	})
	if len(keys) > similarityTopSignals {
		keys = keys[:similarityTopSignals]
	}
	topSignals := make([]signalKeyRef, 0, len(keys))
	for _, key := range keys {
		parts := strings.SplitN(key, ":", 2)
		if len(parts) != 2 {
			continue
		}
		topSignals = append(topSignals, signalKeyRef{signalType: parts[0], signalKey: parts[1]})
	}
	if len(topSignals) == 0 {
		return []SimilarityNeighbor{}, nil
	}
	sharedRows, err := s.selectSharedAggregates(ctx, orgID, userID, topSignals)
	if err != nil {
		return nil, err
	}
	type preview struct {
		sharedSignals map[string]struct{}
		sharedDot     float64
	}
	previewByUser := make(map[string]*preview, len(sharedRows))
	for _, row := range sharedRows {
		key := row.SignalType + ":" + row.SignalKey
		targetValue, exists := targetVector[key]
		if !exists {
			continue
		}
		candidateValue := toDecayedScore(row.Score, row.LastInteractedAt, now)
		if math.Abs(candidateValue) <= collabEpsilon {
			continue
		}
		current, exists := previewByUser[row.UserID]
		if !exists {
			current = &preview{sharedSignals: make(map[string]struct{}, 4)}
			previewByUser[row.UserID] = current
		}
		current.sharedSignals[key] = struct{}{}
		current.sharedDot += targetValue * candidateValue
	}
	type candidate struct {
		userID        string
		sharedSignals int
		sharedDot     float64
	}
	candidates := make([]candidate, 0, len(previewByUser))
	for candidateUserID, entry := range previewByUser {
		if len(entry.sharedSignals) < similarityMinShared {
			continue
		}
		candidates = append(candidates, candidate{
			userID:        candidateUserID,
			sharedSignals: len(entry.sharedSignals),
			sharedDot:     entry.sharedDot,
		})
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].sharedSignals != candidates[right].sharedSignals {
			return candidates[left].sharedSignals > candidates[right].sharedSignals
		}
		return candidates[left].sharedDot > candidates[right].sharedDot
	})
	if len(candidates) > similarityCandidateLimit {
		candidates = candidates[:similarityCandidateLimit]
	}
	if len(candidates) == 0 {
		return []SimilarityNeighbor{}, nil
	}
	candidateIDs := make([]string, 0, len(candidates))
	for _, entry := range candidates {
		candidateIDs = append(candidateIDs, entry.userID)
	}
	candidateRows, err := s.selectAggregatesForUsers(ctx, orgID, candidateIDs)
	if err != nil {
		return nil, err
	}
	rowsByUser := make(map[string][]aggregateRow, len(candidateIDs))
	for _, row := range candidateRows {
		rowsByUser[row.UserID] = append(rowsByUser[row.UserID], row)
	}
	neighbors := make([]SimilarityNeighbor, 0, len(candidates))
	for _, entry := range candidates {
		rows := rowsByUser[entry.userID]
		if len(rows) == 0 {
			continue
		}
		dot := 0.0
		candidateNorm := 0.0
		for _, row := range rows {
			candidateValue := toDecayedScore(row.Score, row.LastInteractedAt, now)
			if math.Abs(candidateValue) <= collabEpsilon {
				continue
			}
			candidateNorm += candidateValue * candidateValue
			key := row.SignalType + ":" + row.SignalKey
			if targetValue, exists := targetVector[key]; exists {
				dot += targetValue * candidateValue
			}
		}
		if candidateNorm <= 0 || dot <= 0 {
			continue
		}
		similarity := dot / math.Sqrt(targetNorm*candidateNorm)
		if math.IsNaN(similarity) || math.IsInf(similarity, 0) || similarity <= 0 {
			continue
		}
		neighbors = append(neighbors, SimilarityNeighbor{
			UserID:        entry.userID,
			Similarity:    round4(similarity),
			SharedSignals: entry.sharedSignals,
		})
	}
	sort.SliceStable(neighbors, func(left, right int) bool {
		if neighbors[left].Similarity != neighbors[right].Similarity {
			return neighbors[left].Similarity > neighbors[right].Similarity
		}
		if neighbors[left].SharedSignals != neighbors[right].SharedSignals {
			return neighbors[left].SharedSignals > neighbors[right].SharedSignals
		}
		return neighbors[left].UserID < neighbors[right].UserID
	})
	if len(neighbors) > similarityNeighborLimit {
		neighbors = neighbors[:similarityNeighborLimit]
	}
	sort.SliceStable(neighbors, func(left, right int) bool {
		return neighbors[left].Similarity > neighbors[right].Similarity
	})
	return neighbors, nil
}

// ensurePersistentAggregateBackfill ports ensurePersistentAggregateBackfill: a
// user with no aggregate rows gets one row per persisted signal dimension entry.
func (s *Service) ensurePersistentAggregateBackfill(ctx context.Context, orgID, userID string) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("%w: database is not configured", errDB)
	}
	var count int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM UserNewsBehaviorAggregate WHERE orgId = ? AND userId = ?",
		orgID, userID).Scan(&count); err != nil {
		return classifyDB(err)
	}
	if count > 0 {
		return nil
	}
	loaded, err := s.load(ctx, orgID, userID)
	if err != nil {
		return err
	}
	var wire wireScoringProfile
	if err := json.Unmarshal(loaded.raw, &wire); err != nil {
		return redisErr(err)
	}
	type backfillRow struct {
		signalType string
		signalKey  string
		score      float64
	}
	rows := make([]backfillRow, 0, 64)
	dimensions := []struct {
		name   string
		signal string
		values map[string]float64
	}{
		{name: "sources", signal: signalSource, values: wire.Net.SourcesRaw},
		{name: "topics", signal: signalTopic, values: wire.Net.TopicsRaw},
		{name: "entities", signal: signalEntity, values: wire.Net.EntitiesRaw},
		{name: "items", signal: signalItem, values: wire.Net.ItemsRaw},
		{name: "events", signal: signalEvent, values: wire.Net.EventsRaw},
		{name: "domains", signal: signalDomain, values: wire.Net.DomainsRaw},
	}
	for _, dimension := range dimensions {
		for key, score := range dimension.values {
			if math.Abs(score) <= collabEpsilon {
				continue
			}
			rows = append(rows, backfillRow{signalType: dimension.signal, signalKey: key, score: round4(score)})
		}
	}
	if len(rows) == 0 {
		return nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	for start := 0; start < len(rows); start += similarityChunkSize {
		end := start + similarityChunkSize
		if end > len(rows) {
			end = len(rows)
		}
		chunk := rows[start:end]
		var builder strings.Builder
		builder.WriteString("INSERT IGNORE INTO UserNewsBehaviorAggregate ")
		builder.WriteString("(id, orgId, userId, signalType, signalKey, score, lastInteractedAt, createdAt, updatedAt) VALUES ")
		arguments := make([]any, 0, len(chunk)*9)
		for index, row := range chunk {
			if index > 0 {
				builder.WriteByte(',')
			}
			builder.WriteString("(?,?,?,?,?,?,?,?,?)")
			id, err := newBehaviorID()
			if err != nil {
				return err
			}
			arguments = append(arguments, id, orgID, userID, row.signalType, row.signalKey, row.score, now, now, now)
		}
		if _, err := s.db.ExecContext(ctx, builder.String(), arguments...); err != nil {
			return classifyDB(err)
		}
	}
	return s.markSnapshotsDirty(ctx, orgID, userID)
}

// selectAggregatesForUser reads the target user's aggregate rows.
func (s *Service) selectAggregatesForUser(ctx context.Context, orgID, userID string) ([]aggregateRow, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT userId, signalType, signalKey, score, lastInteractedAt FROM UserNewsBehaviorAggregate WHERE orgId = ? AND userId = ?",
		orgID, userID)
	if err != nil {
		return nil, classifyDB(err)
	}
	defer func() { _ = rows.Close() }()
	return scanAggregateRows(rows)
}

// selectAggregatesForUsers reads several users' aggregate rows.
func (s *Service) selectAggregatesForUsers(ctx context.Context, orgID string, userIDs []string) ([]aggregateRow, error) {
	out := make([]aggregateRow, 0, len(userIDs)*8)
	for start := 0; start < len(userIDs); start += similarityChunkSize {
		end := start + similarityChunkSize
		if end > len(userIDs) {
			end = len(userIDs)
		}
		chunk := userIDs[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		arguments := make([]any, 0, len(chunk)+1)
		arguments = append(arguments, orgID)
		for _, userID := range chunk {
			arguments = append(arguments, userID)
		}
		rows, err := s.db.QueryContext(ctx,
			"SELECT userId, signalType, signalKey, score, lastInteractedAt FROM UserNewsBehaviorAggregate WHERE orgId = ? AND userId IN ("+placeholders+")",
			arguments...)
		if err != nil {
			return nil, classifyDB(err)
		}
		scanned, err := scanAggregateRows(rows)
		_ = rows.Close()
		if err != nil {
			return nil, err
		}
		out = append(out, scanned...)
	}
	return out, nil
}

// selectSharedAggregates reads the rows of other users that share a top signal.
func (s *Service) selectSharedAggregates(ctx context.Context, orgID, userID string, signals []signalKeyRef) ([]aggregateRow, error) {
	placeholders := make([]string, 0, len(signals))
	arguments := make([]any, 0, len(signals)*2+2)
	arguments = append(arguments, orgID, userID)
	for _, signal := range signals {
		placeholders = append(placeholders, "(?,?)")
		arguments = append(arguments, signal.signalType, signal.signalKey)
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT userId, signalType, signalKey, score, lastInteractedAt FROM UserNewsBehaviorAggregate "+
			"WHERE orgId = ? AND userId <> ? AND (signalType, signalKey) IN ("+strings.Join(placeholders, ",")+")",
		arguments...)
	if err != nil {
		return nil, classifyDB(err)
	}
	defer func() { _ = rows.Close() }()
	return scanAggregateRows(rows)
}

// signalKeyRef is one (signalType, signalKey) pair.
type signalKeyRef struct {
	signalType string
	signalKey  string
}

// scanAggregateRows scans the shared projection.
func scanAggregateRows(rows *sql.Rows) ([]aggregateRow, error) {
	out := make([]aggregateRow, 0, 32)
	for rows.Next() {
		var row aggregateRow
		if err := rows.Scan(&row.UserID, &row.SignalType, &row.SignalKey, &row.Score, &row.LastInteractedAt); err != nil {
			return nil, classifyDB(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, classifyDB(err)
	}
	return out, nil
}

// selectSimilaritySnapshot reads the snapshot row, if any.
func (s *Service) selectSimilaritySnapshot(ctx context.Context, orgID, userID string) (*similaritySnapshotRow, error) {
	var dirty int
	var computedAt sql.NullTime
	var neighbors []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT dirty, computedAt, neighbors FROM UserNewsSimilaritySnapshot WHERE orgId = ? AND userId = ? LIMIT 1",
		orgID, userID).Scan(&dirty, &computedAt, &neighbors)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, classifyDB(err)
	}
	return &similaritySnapshotRow{Dirty: dirty != 0, ComputedAt: computedAt, Neighbors: neighbors}, nil
}

// upsertSimilaritySnapshot writes the computed neighbors.
func (s *Service) upsertSimilaritySnapshot(ctx context.Context, orgID, userID string, neighbors []SimilarityNeighbor, computedAt time.Time) error {
	id, err := newBehaviorID()
	if err != nil {
		return err
	}
	encoded, err := marshalJS(nonNilNeighbors(neighbors))
	if err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err = s.db.ExecContext(ctx,
		"INSERT INTO UserNewsSimilaritySnapshot (id, orgId, userId, dirty, computedAt, neighbors, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?) AS new_row "+
			"ON DUPLICATE KEY UPDATE dirty = new_row.dirty, computedAt = new_row.computedAt,"+
			" neighbors = new_row.neighbors, updatedAt = new_row.updatedAt",
		id, orgID, userID, false, computedAt, encoded, now, now)
	if err != nil {
		return classifyDB(err)
	}
	return nil
}

// withSimilarityLock runs fn while holding the CacheService-compatible lease.
// The first result reports whether the lease was acquired.
func (s *Service) withSimilarityLock(ctx context.Context, orgID, userID string, fn func() error) (bool, error) {
	if s == nil || s.rdb == nil {
		return false, fmt.Errorf("%w: redis is not configured", errRedis)
	}
	token, err := newBehaviorID()
	if err != nil {
		return false, err
	}
	key := "lock:user-news-behavior:similarity:" + orgID + ":" + userID
	acquired, err := s.rdb.SetNX(ctx, key, token, similarityLockTTL).Result()
	if err != nil {
		return false, redisErr(err)
	}
	if !acquired {
		return false, nil
	}
	stopRenew := s.startLockRenewal(key, token, similarityLockTTL)
	runErr := fn()
	stopRenew()
	_, _ = s.rdb.Eval(context.Background(), releaseLockScript, []string{key}, token).Result()
	if runErr != nil {
		return true, runErr
	}
	return true, nil
}

// startLockRenewal extends the lease every third of its TTL.
func (s *Service) startLockRenewal(key, token string, ttl time.Duration) func() {
	interval := ttl / 3
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	stop := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				// The lease belongs to this process; a transient renewal failure
				// only risks another process recomputing the snapshot.
				_, _ = s.rdb.Eval(context.Background(), renewLockScript, []string{key},
					token, strconv.FormatInt(ttl.Milliseconds(), 10)).Result()
			}
		}
	}()
	return func() { once.Do(func() { close(stop) }) }
}

var (
	releaseLockScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `
	renewLockScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      end
      return 0
    `
)

// parseSimilarityNeighbors ports parseSimilarityNeighbors.
func parseSimilarityNeighbors(raw []byte) []SimilarityNeighbor {
	if len(raw) == 0 {
		return []SimilarityNeighbor{}
	}
	var entries []struct {
		UserID        *string  `json:"userId"`
		Similarity    *float64 `json:"similarity"`
		SharedSignals *float64 `json:"sharedSignals"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return []SimilarityNeighbor{}
	}
	neighbors := make([]SimilarityNeighbor, 0, len(entries))
	for _, entry := range entries {
		if entry.UserID == nil || entry.Similarity == nil || entry.SharedSignals == nil {
			continue
		}
		userID := strings.TrimSpace(*entry.UserID)
		if len(userID) > maxIDLength {
			userID = userID[:maxIDLength]
		}
		similarity := round4(*entry.Similarity)
		sharedSignals := int(math.Max(0, math.Floor(*entry.SharedSignals)))
		if userID == "" || similarity <= 0 || sharedSignals < similarityMinShared {
			continue
		}
		neighbors = append(neighbors, SimilarityNeighbor{
			UserID:        userID,
			Similarity:    similarity,
			SharedSignals: sharedSignals,
		})
	}
	sort.SliceStable(neighbors, func(left, right int) bool {
		return neighbors[left].Similarity > neighbors[right].Similarity
	})
	if len(neighbors) > similarityNeighborLimit {
		neighbors = neighbors[:similarityNeighborLimit]
	}
	return neighbors
}

// marshalNeighbors encodes the stored neighbor array.
func marshalNeighbors(neighbors []SimilarityNeighbor) []byte {
	encoded, err := marshalJS(nonNilNeighbors(neighbors))
	if err != nil {
		return []byte("[]")
	}
	return encoded
}

// nonNilNeighbors renders an empty array rather than null.
func nonNilNeighbors(neighbors []SimilarityNeighbor) []SimilarityNeighbor {
	if neighbors == nil {
		return []SimilarityNeighbor{}
	}
	return neighbors
}

// toDecayedScore ports toDecayedScore.
func toDecayedScore(score float64, lastInteractedAt sql.NullTime, now time.Time) float64 {
	if math.IsNaN(score) || math.IsInf(score, 0) || math.Abs(score) <= collabEpsilon {
		return 0
	}
	if !lastInteractedAt.Valid {
		return round4(score)
	}
	ageDays := math.Max(0, now.Sub(lastInteractedAt.Time).Hours()/24)
	return round4(score * decayWeight(ageDays))
}

// signalTypeDimension maps the stored signal type to the profile dimension.
func signalTypeDimension(signalType string) (string, bool) {
	switch signalType {
	case signalSource:
		return "sources", true
	case signalTopic:
		return "topics", true
	case signalEntity:
		return "entities", true
	case signalItem:
		return "items", true
	case signalEvent:
		return "events", true
	case signalDomain:
		return "domains", true
	default:
		return "", false
	}
}

// isoTimeValue formats an instant like Date.prototype.toISOString.
func isoTimeValue(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// isoTimePtr formats an optional database instant.
func isoTimePtr(value sql.NullTime) *string {
	if !value.Valid {
		return nil
	}
	formatted := isoTimeValue(value.Time)
	return &formatted
}

// parseISOTimeValue parses the ISO shape this package writes.
func parseISOTimeValue(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed.UTC()
}
