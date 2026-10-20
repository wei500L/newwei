package sentimentsnapshot

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"math"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var errNoDatabase = errors.New("sentimentsnapshot: mysql is not configured")

// storeOptions are the storage handles one rebuild needs.
type storeOptions struct {
	DB    *sql.DB
	Mongo *mongo.Database
	Now   func() time.Time
}

// store reads the Mongo aggregation and rewrites the two MySQL snapshot tables.
type store struct {
	db    *sql.DB
	mongo *mongo.Database
	now   func() time.Time
}

func newStore(options storeOptions) *store {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &store{db: options.DB, mongo: options.Mongo, now: now}
}

func (s *store) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

// rawEntityRow is one undecoded aggregation document. Every counter stays a
// BSON value because $sum may return int32, int64 or double.
type rawEntityRow struct {
	Name         bson.RawValue `bson:"name"`
	Type         bson.RawValue `bson:"type"`
	TotalDocs    bson.RawValue `bson:"totalDocs"`
	NegativeDocs bson.RawValue `bson:"negativeDocs"`
	PositiveDocs bson.RawValue `bson:"positiveDocs"`
	NeutralDocs  bson.RawValue `bson:"neutralDocs"`
	ScoreSum     bson.RawValue `bson:"scoreSum"`
}

type rawTopicRow struct {
	Topic        bson.RawValue `bson:"topic"`
	TotalDocs    bson.RawValue `bson:"totalDocs"`
	NegativeDocs bson.RawValue `bson:"negativeDocs"`
	PositiveDocs bson.RawValue `bson:"positiveDocs"`
	NeutralDocs  bson.RawValue `bson:"neutralDocs"`
	ScoreSum     bson.RawValue `bson:"scoreSum"`
}

// aggregateEntitySentiment is aggregateEntitySentiment. allowDiskUse is on, as in
// the NestJS pipeline.
func (s *store) aggregateEntitySentiment(ctx context.Context, orgID string, start, end time.Time) ([]sentimentAggregateRow, error) {
	if s == nil || s.mongo == nil {
		return nil, nil
	}
	cursor, err := s.mongo.Collection(processedItemsName).Aggregate(ctx,
		entitySentimentPipeline(orgID, start, end), options.Aggregate().SetAllowDiskUse(true))
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	rows := make([]sentimentAggregateRow, 0, 64)
	for cursor.Next(ctx) {
		var raw rawEntityRow
		if err := cursor.Decode(&raw); err != nil {
			return nil, err
		}
		name, ok := raw.Name.StringValueOK()
		if !ok || name == "" {
			continue
		}
		entityType, _ := raw.Type.StringValueOK()
		rows = append(rows, sentimentAggregateRow{
			Name:         name,
			Type:         entityType,
			TotalDocs:    bsonCounter(raw.TotalDocs),
			NegativeDocs: bsonCounter(raw.NegativeDocs),
			PositiveDocs: bsonCounter(raw.PositiveDocs),
			NeutralDocs:  bsonCounter(raw.NeutralDocs),
			ScoreSum:     bsonCounter(raw.ScoreSum),
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return rows, nil
}

// aggregateTopicSentiment is aggregateTopicSentiment.
func (s *store) aggregateTopicSentiment(ctx context.Context, orgID string, start, end time.Time) ([]topicAggregateRow, error) {
	if s == nil || s.mongo == nil {
		return nil, nil
	}
	cursor, err := s.mongo.Collection(processedItemsName).Aggregate(ctx,
		topicSentimentPipeline(orgID, start, end), options.Aggregate().SetAllowDiskUse(true))
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	rows := make([]topicAggregateRow, 0, 64)
	for cursor.Next(ctx) {
		var raw rawTopicRow
		if err := cursor.Decode(&raw); err != nil {
			return nil, err
		}
		topic, ok := raw.Topic.StringValueOK()
		if !ok || topic == "" {
			continue
		}
		rows = append(rows, topicAggregateRow{
			Topic:        topic,
			TotalDocs:    bsonCounter(raw.TotalDocs),
			NegativeDocs: bsonCounter(raw.NegativeDocs),
			PositiveDocs: bsonCounter(raw.PositiveDocs),
			NeutralDocs:  bsonCounter(raw.NeutralDocs),
			ScoreSum:     bsonCounter(raw.ScoreSum),
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return rows, nil
}

// bsonCounter normalizes a $sum accumulator to int64. Mongo widens a mixed
// accumulator to double; the values are always integral, and MySQL rounds a
// fractional double on assignment to an INT column, so rounding here matches.
func bsonCounter(value bson.RawValue) int64 {
	if number, ok := value.Int32OK(); ok {
		return int64(number)
	}
	if number, ok := value.Int64OK(); ok {
		return number
	}
	if number, ok := value.DoubleOK(); ok {
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return 0
		}
		return int64(math.Round(number))
	}
	return 0
}

// writeBucket rewrites one UTC day inside a single transaction: delete the
// existing rows for (orgId, bucketStart) from both tables, then insert the fresh
// aggregates.
func (s *store) writeBucket(ctx context.Context, orgID string, bucketStart time.Time, entities []sentimentAggregateRow, topics []topicAggregateRow, now time.Time) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	for _, table := range []string{entitySnapshotTable, topicSnapshotTable} {
		if _, err := tx.ExecContext(ctx,
			"DELETE FROM `"+table+"` WHERE `orgId` = ? AND `bucketStart` = ?", orgID, bucketStart); err != nil {
			return err
		}
	}
	if len(entities) > 0 {
		if err := insertEntityRows(ctx, tx, orgID, bucketStart, entities, now); err != nil {
			return err
		}
	}
	if len(topics) > 0 {
		if err := insertTopicRows(ctx, tx, orgID, bucketStart, topics, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// insertEntityRows writes the entity aggregates in chunks.
//
// B2: Mongoose's $group distinguishes names by their exact bytes ("Apple" and
// "apple", "Café" and "Cafe", a trailing space and its absence), while the
// unique index uses utf8mb4_unicode_ci, which considers them equal. Prisma's
// createMany then aborted the whole transaction, so that organization's day kept
// its previous rows and every hourly rebuild failed again. ON DUPLICATE KEY
// UPDATE merges the colliding rows in the same transaction instead: the counters
// accumulate, the name and type of the first (therefore highest-document) row are
// kept, and avgScore/negativeRatio are recomputed with a DOUBLE division so MySQL
// does not truncate an INT division to four decimals.
func insertEntityRows(ctx context.Context, tx *sql.Tx, orgID string, bucketStart time.Time, rows []sentimentAggregateRow, now time.Time) error {
	for start := 0; start < len(rows); start += sentimentWriteChunk {
		end := start + sentimentWriteChunk
		if end > len(rows) {
			end = len(rows)
		}
		chunk := rows[start:end]
		var values strings.Builder
		values.Grow(len(chunk) * 120)
		args := make([]any, 0, len(chunk)*13)
		for index, row := range chunk {
			id, err := newRowID()
			if err != nil {
				return err
			}
			if index > 0 {
				values.WriteString(",")
			}
			values.WriteString("(?,?,?,?,?,?,?,?,?,?,?,?,?)")
			args = append(args, id, orgID, row.Name, row.Type, bucketStart,
				row.TotalDocs, row.NegativeDocs, row.PositiveDocs, row.NeutralDocs, row.ScoreSum,
				row.avgScore(), row.negativeRatio(), now)
		}
		query := "INSERT INTO `" + entitySnapshotTable + "` " +
			"(`id`,`orgId`,`entityName`,`entityType`,`bucketStart`,`totalDocs`,`negativeDocs`," +
			"`positiveDocs`,`neutralDocs`,`scoreSum`,`avgScore`,`negativeRatio`,`updatedAt`) VALUES " +
			values.String() + " ON DUPLICATE KEY UPDATE " + mergeAccumulateSQL()
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return err
		}
	}
	return nil
}

// insertTopicRows is insertEntityRows for TopicSentimentSnapshot.
func insertTopicRows(ctx context.Context, tx *sql.Tx, orgID string, bucketStart time.Time, rows []topicAggregateRow, now time.Time) error {
	for start := 0; start < len(rows); start += sentimentWriteChunk {
		end := start + sentimentWriteChunk
		if end > len(rows) {
			end = len(rows)
		}
		chunk := rows[start:end]
		var values strings.Builder
		values.Grow(len(chunk) * 110)
		args := make([]any, 0, len(chunk)*12)
		for index, row := range chunk {
			id, err := newRowID()
			if err != nil {
				return err
			}
			if index > 0 {
				values.WriteString(",")
			}
			values.WriteString("(?,?,?,?,?,?,?,?,?,?,?,?)")
			args = append(args, id, orgID, row.Topic, bucketStart,
				row.TotalDocs, row.NegativeDocs, row.PositiveDocs, row.NeutralDocs, row.ScoreSum,
				row.avgScore(), row.negativeRatio(), now)
		}
		query := "INSERT INTO `" + topicSnapshotTable + "` " +
			"(`id`,`orgId`,`topic`,`bucketStart`,`totalDocs`,`negativeDocs`," +
			"`positiveDocs`,`neutralDocs`,`scoreSum`,`avgScore`,`negativeRatio`,`updatedAt`) VALUES " +
			values.String() + " ON DUPLICATE KEY UPDATE " + mergeAccumulateSQL()
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return err
		}
	}
	return nil
}

// mergeAccumulateSQL is the single ON DUPLICATE KEY UPDATE list for the whole
// statement.
//
// The assignment list must appear once: a repeated list would apply every chunk
// row's increment to whichever row conflicted. It uses the VALUES() function
// rather than the 8.0.19 row alias because the accumulation form
// "totalDocs = totalDocs + <new>" is ambiguous once an alias introduces a second
// totalDocs column (MySQL error 1052). VALUES() is deprecated but still supported
// and is the form the existing crawlreadtelemetry / qualityoverview / economicdata
// upserts use.
//
// MySQL evaluates the list left to right and every reference to a target column
// sees the value the previous assignment produced, so totalDocs / negativeDocs /
// scoreSum are already accumulated when avgScore and negativeRatio are
// recomputed.
func mergeAccumulateSQL() string {
	return "`totalDocs`=`totalDocs`+VALUES(`totalDocs`)," +
		"`negativeDocs`=`negativeDocs`+VALUES(`negativeDocs`)," +
		"`positiveDocs`=`positiveDocs`+VALUES(`positiveDocs`)," +
		"`neutralDocs`=`neutralDocs`+VALUES(`neutralDocs`)," +
		"`scoreSum`=`scoreSum`+VALUES(`scoreSum`)," +
		"`avgScore`=" + averageExpression("scoreSum") + "," +
		"`negativeRatio`=" + averageExpression("negativeDocs") + "," +
		"`updatedAt`=VALUES(`updatedAt`)"
}

// averageExpression is the merged average: numerator / totalDocs as DOUBLE, and
// 0e0 when the merged totalDocs is 0. The 0e0 literal keeps both CASE branches
// DOUBLE so MySQL never falls back to the four-decimal DECIMAL division.
func averageExpression(numerator string) string {
	return "CASE WHEN `totalDocs`=0 THEN 0e0 ELSE CAST(`" + numerator + "` AS DOUBLE)/`totalDocs` END"
}

// newRowID writes a Prisma cuid-shaped primary key. The column has no database
// default, so a client-side id is required on every insert.
func newRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}
