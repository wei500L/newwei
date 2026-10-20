package realtimeevents

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Queue-specific orgId lookups, mirroring the NestJS publishers:
//
//	analysis  : job.data.orgId -> job.data.analysisId -> AnalysisResultModel
//	            -> jobId prefix corr-<id> / anomaly-<id>
//	assistant : job.data.orgId -> job.data.runId -> AssistantRunModel
//	            -> jobId ^assistant:(query|report|forecast):<runId>$
//	alerts    : job.data.orgId -> evaluate/ruleId -> AlertRule
//	            -> deliver/deliveryId -> AlertDelivery.event.rule.orgId
//	            -> jobId evaluate:<ruleId> / evaluate-<ruleId> / deliver-<deliveryId>
//
// The Mongo collections are the Mongoose collections shared with NestJS:
// analysisresults (analysisruns/store.go) and assistantruns
// (accountdata/mongo_runs.go). The SQL tables are the Prisma models AlertRule,
// AlertEvent and AlertDelivery.

type orgLookupIdentifier struct {
	kind string
	id   string
}

const (
	identifierAnalysis = "analysis"
	identifierRun      = "run"
	identifierRule     = "rule"
	identifierDelivery = "delivery"
)

// orgIDLookup is the queue-specific strategy used by simpleOrgResolver.
type orgIDLookup interface {
	OrgIDFromJobData(fields map[string]json.RawMessage) (string, bool)
	IdentifierFromJobData(fields map[string]json.RawMessage) (orgLookupIdentifier, bool)
	ResolveIdentifier(ctx context.Context, identifier orgLookupIdentifier) (string, bool)
	InferIdentifier(jobID string) (orgLookupIdentifier, bool)
}

// analysisLookup resolves the analysis queue tenant.
type analysisLookup struct {
	mongo *mongoOrgLookup
}

func newAnalysisOrgLookup(database *mongo.Database) *analysisLookup {
	return &analysisLookup{mongo: &mongoOrgLookup{database: database, collection: "analysisresults", kind: identifierAnalysis}}
}

func (l *analysisLookup) OrgIDFromJobData(fields map[string]json.RawMessage) (string, bool) {
	return jobDataOrgID(fields)
}

func (l *analysisLookup) IdentifierFromJobData(fields map[string]json.RawMessage) (orgLookupIdentifier, bool) {
	value, ok := jobDataRawString(fields, "analysisId")
	if !ok {
		return orgLookupIdentifier{}, false
	}
	return orgLookupIdentifier{kind: identifierAnalysis, id: value}, true
}

func (l *analysisLookup) ResolveIdentifier(ctx context.Context, identifier orgLookupIdentifier) (string, bool) {
	if identifier.kind != identifierAnalysis {
		return "", false
	}
	return l.mongo.lookup(ctx, identifier.id)
}

func (l *analysisLookup) InferIdentifier(jobID string) (orgLookupIdentifier, bool) {
	// inferAnalysisIdFromJobId: corr-<id> / anomaly-<id>.
	if strings.HasPrefix(jobID, "corr-") {
		if id := jobID[len("corr-"):]; id != "" {
			return orgLookupIdentifier{kind: identifierAnalysis, id: id}, true
		}
	}
	if strings.HasPrefix(jobID, "anomaly-") {
		if id := jobID[len("anomaly-"):]; id != "" {
			return orgLookupIdentifier{kind: identifierAnalysis, id: id}, true
		}
	}
	return orgLookupIdentifier{}, false
}

// assistantLookup resolves the assistant queue tenant.
type assistantLookup struct {
	mongo *mongoOrgLookup
}

func newAssistantOrgLookup(database *mongo.Database) *assistantLookup {
	return &assistantLookup{mongo: &mongoOrgLookup{database: database, collection: "assistantruns", kind: identifierRun}}
}

func (l *assistantLookup) OrgIDFromJobData(fields map[string]json.RawMessage) (string, bool) {
	return jobDataOrgID(fields)
}

func (l *assistantLookup) IdentifierFromJobData(fields map[string]json.RawMessage) (orgLookupIdentifier, bool) {
	value, ok := jobDataRawString(fields, "runId")
	if !ok {
		return orgLookupIdentifier{}, false
	}
	return orgLookupIdentifier{kind: identifierRun, id: value}, true
}

func (l *assistantLookup) ResolveIdentifier(ctx context.Context, identifier orgLookupIdentifier) (string, bool) {
	if identifier.kind != identifierRun {
		return "", false
	}
	return l.mongo.lookup(ctx, identifier.id)
}

func (l *assistantLookup) InferIdentifier(jobID string) (orgLookupIdentifier, bool) {
	// ^assistant:(query|report|forecast):(.+)$
	matches := assistantJobIDPattern.FindStringSubmatch(jobID)
	if len(matches) != 3 {
		return orgLookupIdentifier{}, false
	}
	// inferRunIdFromJobId trims the captured id.
	runID := strings.TrimSpace(matches[2])
	if runID == "" {
		return orgLookupIdentifier{}, false
	}
	return orgLookupIdentifier{kind: identifierRun, id: runID}, true
}

// mongoOrgLookup reads the orgId field of one Mongo document by _id.
type mongoOrgLookup struct {
	database   *mongo.Database
	collection string
	kind       string
	warnOnce   sync.Once
}

func (l *mongoOrgLookup) lookup(ctx context.Context, id string) (string, bool) {
	if l == nil || l.database == nil {
		l.warnOnce.Do(func() {
			log.Printf("realtimeevents: Mongo is not configured; %s events without a job-data orgId are dropped", l.kind)
		})
		return "", false
	}
	filter := bson.D{{Key: "_id", Value: mongoIDValue(id)}}
	projection := options.FindOne().SetProjection(bson.D{{Key: "orgId", Value: 1}})
	var document struct {
		OrgID string `bson:"orgId"`
	}
	err := l.database.Collection(l.collection).FindOne(ctx, filter, projection).Decode(&document)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", false
	}
	if err != nil {
		log.Printf("realtimeevents: %s orgId lookup for %q failed: %v", l.kind, id, err)
		return "", false
	}
	orgID := strings.TrimSpace(document.OrgID)
	if orgID == "" {
		return "", false
	}
	return orgID, true
}

// mongoIDValue converts a cuid-shaped string id to the ObjectID Mongo stores
// when possible, and falls back to the string form (the projection is shared by
// documents that may key a string _id).
func mongoIDValue(id string) any {
	if len(id) == 24 {
		if decoded, err := hex.DecodeString(id); err == nil {
			var objectID bson.ObjectID
			copy(objectID[:], decoded)
			return objectID
		}
	}
	return id
}

// alertsLookup resolves the alerts queue tenant from MySQL.
type alertsLookup struct {
	db       *sql.DB
	warnOnce sync.Once
}

func newAlertsOrgLookup(db *sql.DB) *alertsLookup {
	return &alertsLookup{db: db}
}

func (l *alertsLookup) OrgIDFromJobData(fields map[string]json.RawMessage) (string, bool) {
	return jobDataOrgID(fields)
}

func (l *alertsLookup) IdentifierFromJobData(fields map[string]json.RawMessage) (orgLookupIdentifier, bool) {
	jobType, _ := jobDataRawString(fields, "type")
	switch jobType {
	case "evaluate":
		if value, ok := jobDataRawString(fields, "ruleId"); ok {
			return orgLookupIdentifier{kind: identifierRule, id: value}, true
		}
	case "deliver":
		if value, ok := jobDataRawString(fields, "deliveryId"); ok {
			return orgLookupIdentifier{kind: identifierDelivery, id: value}, true
		}
	}
	return orgLookupIdentifier{}, false
}

func (l *alertsLookup) ResolveIdentifier(ctx context.Context, identifier orgLookupIdentifier) (string, bool) {
	if l == nil || l.db == nil {
		l.warnOnce.Do(func() {
			log.Printf("realtimeevents: MySQL is not configured; alerts events without a job-data orgId are dropped")
		})
		return "", false
	}
	switch identifier.kind {
	case identifierRule:
		var orgID sql.NullString
		err := l.db.QueryRowContext(ctx, "SELECT `orgId` FROM `AlertRule` WHERE `id` = ?", identifier.id).Scan(&orgID)
		if errors.Is(err, sql.ErrNoRows) {
			return "", false
		}
		if err != nil {
			log.Printf("realtimeevents: alert rule orgId lookup %q failed: %v", identifier.id, err)
			return "", false
		}
		return nonEmptyOrgID(orgID)
	case identifierDelivery:
		// AlertDelivery.event (AlertEvent) -> AlertEvent.rule (AlertRule).
		var orgID sql.NullString
		err := l.db.QueryRowContext(ctx, "SELECT `r`.`orgId` FROM `AlertDelivery` `d` "+
			"JOIN `AlertEvent` `e` ON `e`.`id` = `d`.`eventId` "+
			"JOIN `AlertRule` `r` ON `r`.`id` = `e`.`ruleId` "+
			"WHERE `d`.`id` = ?", identifier.id).Scan(&orgID)
		if errors.Is(err, sql.ErrNoRows) {
			return "", false
		}
		if err != nil {
			log.Printf("realtimeevents: alert delivery orgId lookup %q failed: %v", identifier.id, err)
			return "", false
		}
		return nonEmptyOrgID(orgID)
	default:
		return "", false
	}
}

func (l *alertsLookup) InferIdentifier(jobID string) (orgLookupIdentifier, bool) {
	// inferOrgLookupFromJobId: scan-active-rules has no tenant; deliver-<id>
	// is a delivery; evaluate:<ruleId> and evaluate-<ruleId> are rules.
	if jobID == "scan-active-rules" {
		return orgLookupIdentifier{}, false
	}
	if strings.HasPrefix(jobID, "deliver-") {
		if id := jobID[len("deliver-"):]; id != "" {
			return orgLookupIdentifier{kind: identifierDelivery, id: id}, true
		}
	}
	if strings.HasPrefix(jobID, "evaluate:") {
		parts := strings.Split(jobID, ":")
		if len(parts) > 1 {
			if id := strings.TrimSpace(parts[1]); id != "" {
				return orgLookupIdentifier{kind: identifierRule, id: id}, true
			}
		}
	}
	if strings.HasPrefix(jobID, "evaluate-") {
		if id := jobID[len("evaluate-"):]; id != "" {
			return orgLookupIdentifier{kind: identifierRule, id: id}, true
		}
	}
	return orgLookupIdentifier{}, false
}

func nonEmptyOrgID(value sql.NullString) (string, bool) {
	if !value.Valid {
		return "", false
	}
	trimmed := strings.TrimSpace(value.String)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// jobDataOrgID reads the `orgId` string field of a job data document. The
// NestJS publishers require a non-empty string; analysis keeps the value
// verbatim while crawl/assistant/alerts trim it, which is handled by the
// callers.
func jobDataOrgID(fields map[string]json.RawMessage) (string, bool) {
	value, ok := jobDataRawString(fields, "orgId")
	if !ok {
		return "", false
	}
	return value, true
}

// jobDataRawString reads one string field without trimming it, matching the
// `typeof value === "string" && value.length > 0` guards.
func jobDataRawString(fields map[string]json.RawMessage, name string) (string, bool) {
	raw, ok := fields[name]
	if !ok {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil || value == "" {
		return "", false
	}
	return value, true
}

// jobDataTrimmedString reads one string field and trims it.
func jobDataTrimmedString(fields map[string]json.RawMessage, name string) (string, bool) {
	raw, ok := fields[name]
	if !ok {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}
