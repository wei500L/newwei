package sentimentsnapshot

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// This file reproduces the two aggregation pipelines from
// sentiment-snapshot.ingestion.service.ts stage by stage. The stage order, the
// operator arguments and the sort keys are the same; the only addition is the
// explicit 5000 row limit already present in the NestJS pipeline.

// entitySentimentPipeline is aggregateEntitySentiment's pipeline.
func entitySentimentPipeline(orgID string, start, end time.Time) bson.A {
	return bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
			{Key: "createdAt", Value: bson.D{
				{Key: "$gte", Value: start},
				{Key: "$lt", Value: end},
			}},
			{Key: "result.sentiment_label", Value: bson.D{
				{Key: "$exists", Value: true},
				{Key: "$ne", Value: nil},
			}},
			{Key: "result.entities", Value: bson.D{
				{Key: "$exists", Value: true},
				{Key: "$ne", Value: bson.A{}},
			}},
		}}},
		bson.D{{Key: "$unwind", Value: "$result.entities"}},
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "result.entities.name", Value: bson.D{
				{Key: "$type", Value: "string"},
				{Key: "$ne", Value: ""},
			}},
			{Key: "result.entities.confidence", Value: bson.D{
				{Key: "$gte", Value: minEntityConfidence},
			}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "name", Value: "$result.entities.name"},
			{Key: "type", Value: bson.D{{Key: "$toLower", Value: bson.D{
				{Key: "$ifNull", Value: bson.A{"$result.entities.type", ""}},
			}}}},
			{Key: "sentiment", Value: bson.D{{Key: "$toLower", Value: "$result.sentiment_label"}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "name", Value: 1},
			{Key: "type", Value: 1},
			{Key: "score", Value: sentimentScoreExpression()},
			{Key: "neg", Value: sentimentCounterExpression("negative")},
			{Key: "pos", Value: sentimentCounterExpression("positive")},
			{Key: "neu", Value: sentimentCounterExpression("neutral")},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{
				{Key: "name", Value: "$name"},
				{Key: "type", Value: "$type"},
			}},
			{Key: "totalDocs", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "negativeDocs", Value: bson.D{{Key: "$sum", Value: "$neg"}}},
			{Key: "positiveDocs", Value: bson.D{{Key: "$sum", Value: "$pos"}}},
			{Key: "neutralDocs", Value: bson.D{{Key: "$sum", Value: "$neu"}}},
			{Key: "scoreSum", Value: bson.D{{Key: "$sum", Value: "$score"}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "name", Value: bson.D{{Key: "$substrCP", Value: bson.A{"$_id.name", 0, maxNameCodePoints}}}},
			{Key: "type", Value: bson.D{{Key: "$substrCP", Value: bson.A{"$_id.type", 0, maxNameCodePoints}}}},
			{Key: "totalDocs", Value: 1},
			{Key: "negativeDocs", Value: 1},
			{Key: "positiveDocs", Value: 1},
			{Key: "neutralDocs", Value: 1},
			{Key: "scoreSum", Value: 1},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{
			{Key: "totalDocs", Value: -1},
			{Key: "negativeDocs", Value: -1},
		}}},
		bson.D{{Key: "$limit", Value: maxRowsPerBucket}},
	}
}

// topicSentimentPipeline is aggregateTopicSentiment's pipeline.
func topicSentimentPipeline(orgID string, start, end time.Time) bson.A {
	return bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
			{Key: "createdAt", Value: bson.D{
				{Key: "$gte", Value: start},
				{Key: "$lt", Value: end},
			}},
			{Key: "result.sentiment_label", Value: bson.D{
				{Key: "$exists", Value: true},
				{Key: "$ne", Value: nil},
			}},
			{Key: "result.topics", Value: bson.D{
				{Key: "$exists", Value: true},
				{Key: "$ne", Value: bson.A{}},
			}},
		}}},
		bson.D{{Key: "$unwind", Value: "$result.topics"}},
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "result.topics", Value: bson.D{
				{Key: "$type", Value: "string"},
				{Key: "$ne", Value: ""},
			}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "topic", Value: "$result.topics"},
			{Key: "sentiment", Value: bson.D{{Key: "$toLower", Value: "$result.sentiment_label"}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "topic", Value: 1},
			{Key: "score", Value: sentimentScoreExpression()},
			{Key: "neg", Value: sentimentCounterExpression("negative")},
			{Key: "pos", Value: sentimentCounterExpression("positive")},
			{Key: "neu", Value: sentimentCounterExpression("neutral")},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{{Key: "topic", Value: "$topic"}}},
			{Key: "totalDocs", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "negativeDocs", Value: bson.D{{Key: "$sum", Value: "$neg"}}},
			{Key: "positiveDocs", Value: bson.D{{Key: "$sum", Value: "$pos"}}},
			{Key: "neutralDocs", Value: bson.D{{Key: "$sum", Value: "$neu"}}},
			{Key: "scoreSum", Value: bson.D{{Key: "$sum", Value: "$score"}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "topic", Value: bson.D{{Key: "$substrCP", Value: bson.A{"$_id.topic", 0, maxNameCodePoints}}}},
			{Key: "totalDocs", Value: 1},
			{Key: "negativeDocs", Value: 1},
			{Key: "positiveDocs", Value: 1},
			{Key: "neutralDocs", Value: 1},
			{Key: "scoreSum", Value: 1},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{
			{Key: "totalDocs", Value: -1},
			{Key: "negativeDocs", Value: -1},
		}}},
		bson.D{{Key: "$limit", Value: maxRowsPerBucket}},
	}
}

// sentimentScoreExpression is the $switch that maps a lowercased label onto
// +1/0/-1 with a 0 default.
func sentimentScoreExpression() bson.D {
	return bson.D{{Key: "$switch", Value: bson.D{
		{Key: "branches", Value: bson.A{
			bson.D{
				{Key: "case", Value: bson.D{{Key: "$eq", Value: bson.A{"$sentiment", "positive"}}}},
				{Key: "then", Value: 1},
			},
			bson.D{
				{Key: "case", Value: bson.D{{Key: "$eq", Value: bson.A{"$sentiment", "neutral"}}}},
				{Key: "then", Value: 0},
			},
			bson.D{
				{Key: "case", Value: bson.D{{Key: "$eq", Value: bson.A{"$sentiment", "negative"}}}},
				{Key: "then", Value: -1},
			},
		}},
		{Key: "default", Value: 0},
	}}}
}

// sentimentCounterExpression is the $cond that counts one label.
func sentimentCounterExpression(label string) bson.D {
	return bson.D{{Key: "$cond", Value: bson.A{
		bson.D{{Key: "$eq", Value: bson.A{"$sentiment", label}}},
		1,
		0,
	}}}
}
