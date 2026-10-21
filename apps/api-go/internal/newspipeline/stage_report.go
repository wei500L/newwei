package newspipeline

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

// This file ports recordStageOutcome / updatePipelineJobStageMetadata and the
// PipelineJob.metadata stage bookkeeping.
//
// O1 optimization: the TypeScript code reads PipelineJob.metadata, shallow-copies
// metadata / metadata.extraction / metadata.extraction.stages, writes one stage
// entry, stamps extraction.updatedAt and writes the whole JSON back (read-modify-
// write, three copies per stage). This port performs the identical transformation
// in ONE MySQL statement:
//
//	metadata = JSON_SET(
//	  <metadata-as-object>,
//	  '$.extraction', JSON_SET(
//	    <extraction-as-object>,
//	    '$.stages', JSON_SET(<stages-as-object>, '$.<stage>', CAST(? AS JSON)),
//	    '$.updatedAt', ?))
//
// where every "<x>-as-object" is JSON_EXTRACT(CASE WHEN JSON_TYPE(x) = 'OBJECT'
// THEN x ELSE JSON_OBJECT() END, '$'). That CASE reproduces the TypeScript
// "object and not array, else {}" normalisation, JSON_SET preserves every other
// member, and the final JSON is the same value the read-modify-write produced
// (MySQL normalises JSON object key order either way). Prisma's @updatedAt column
// write is kept.

// pipelineStageOutcomeData is the optional data member of a recordStageOutcome
// TaskLog. The member order matches the TypeScript literal: reason, then the
// preflight score members.
type pipelineStageOutcomeData struct {
	Reason                    *string  `json:"reason,omitempty"`
	PreflightQualityScore     *float64 `json:"preflightQualityScore,omitempty"`
	PreflightQualityThreshold *float64 `json:"preflightQualityThreshold,omitempty"`
}

// pipelineStageOutcomeLogData is the TaskLog data payload of a stage outcome:
// the stage-specific members first, then the stage meta entry (the TypeScript
// code spreads data first and stageMeta last).
type pipelineStageOutcomeLogData struct {
	Reason                    *string         `json:"reason,omitempty"`
	PreflightQualityScore     *float64        `json:"preflightQualityScore,omitempty"`
	PreflightQualityThreshold *float64        `json:"preflightQualityThreshold,omitempty"`
	StageMeta                 *StageMetaEntry `json:"stageMeta,omitempty"`
}

// pipelineStageFailureURLRunID is the llm/clean stage onErrorData payload
// ({url, runId}). runId is written as null when the crawl run is unknown, which
// is why the pointer has no omitempty.
type pipelineStageFailureURLRunID struct {
	URL   string  `json:"url"`
	RunID *string `json:"runId"`
}

// pipelineStageFailureRawItem is the normalize stage onErrorData payload.
type pipelineStageFailureRawItem struct {
	RawItemID string `json:"rawItemId"`
}

// pipelineStageFailureURL is the crawl stage onErrorData payload.
type pipelineStageFailureURL struct {
	URL string `json:"url"`
}

// pipelineStageFailureItemMeta is the classify stage onErrorData payload.
type pipelineStageFailureItemMeta struct {
	ItemMetaID string `json:"itemMetaId"`
}

// pipelineStageFailureRawItemMeta is the persist stage onErrorData payload.
type pipelineStageFailureRawItemMeta struct {
	RawItemID  string `json:"rawItemId"`
	ItemMetaID string `json:"itemMetaId"`
}

// pipelineMetadataExec runs the O1 statement. It is a field (not a direct *sql.DB
// call) so tests can capture the generated SQL and arguments without a database.
type pipelineMetadataExec func(ctx context.Context, query string, args ...any) error

// pipelineStageNamePattern restricts the JSON path key. Every real stage name is
// a lower-case identifier; an unexpected name is skipped (and logged) rather
// than spliced into a JSON path.
var pipelineStageNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// recordStageOutcome is recordStageOutcome: best-effort TaskLog first, then the
// O1 PipelineJob.metadata update. Neither failure propagates.
func (s *Service) recordStageOutcome(ctx context.Context, job Job, stage string, entry *StageMetaEntry, data *pipelineStageOutcomeData) {
	logData := pipelineStageOutcomeLogData{StageMeta: entry}
	if data != nil {
		logData.Reason = data.Reason
		logData.PreflightQualityScore = data.PreflightQualityScore
		logData.PreflightQualityThreshold = data.PreflightQualityThreshold
	}
	status := pipelineTaskLogStatusCompleted
	if entry != nil && entry.Status == "failed" {
		status = pipelineTaskLogStatusFailed
	}
	s.writeTaskLog(ctx, taskLogWritePayload{
		Queue:  job.Queue,
		JobID:  job.JobID,
		OrgID:  job.OrgID,
		Stage:  stage,
		Status: status,
		Data:   logData,
	})
	s.updatePipelineJobStageMetadata(ctx, job, stage, entry)
}

// updatePipelineJobStageMetadata is updatePipelineJobStageMetadata. Errors are
// logged and swallowed exactly like the TypeScript try/catch.
func (s *Service) updatePipelineJobStageMetadata(ctx context.Context, job Job, stage string, entry *StageMetaEntry) {
	if job.PipelineJobID == nil || *job.PipelineJobID == "" || entry == nil {
		return
	}
	query, args, ok := buildPipelineJobStageMetadataUpdate(stage, entry, s.now(), *job.PipelineJobID, job.OrgID)
	if !ok {
		s.logf("skipping pipeline job metadata update for unsupported stage %q", stage)
		return
	}
	if s.metadataExec == nil {
		return
	}
	if err := s.metadataExec(ctx, query, args...); err != nil {
		s.logf("failed to update pipeline job extraction metadata for pipelineJobId %s stage %s: %v", *job.PipelineJobID, stage, err)
	}
}

// buildPipelineJobStageMetadataUpdate builds the single-statement O1 update.
// ok is false for an empty pipeline job id or a stage name that is not a safe
// JSON path key.
func buildPipelineJobStageMetadataUpdate(stage string, entry *StageMetaEntry, now time.Time, pipelineJobID, orgID string) (query string, args []any, ok bool) {
	if pipelineJobID == "" || entry == nil || !pipelineStageNamePattern.MatchString(stage) {
		return "", nil, false
	}
	entryJSON, err := json.Marshal(entry)
	if err != nil {
		return "", nil, false
	}
	metadataObject := "JSON_EXTRACT(CASE WHEN JSON_TYPE(`metadata`) = 'OBJECT' THEN `metadata` ELSE JSON_OBJECT() END, '$')"
	extractionObject := "JSON_EXTRACT(CASE WHEN JSON_TYPE(JSON_EXTRACT(`metadata`, '$.extraction')) = 'OBJECT' THEN JSON_EXTRACT(`metadata`, '$.extraction') ELSE JSON_OBJECT() END, '$')"
	stagesObject := "JSON_EXTRACT(CASE WHEN JSON_TYPE(JSON_EXTRACT(`metadata`, '$.extraction.stages')) = 'OBJECT' THEN JSON_EXTRACT(`metadata`, '$.extraction.stages') ELSE JSON_OBJECT() END, '$')"
	updatedAtISO := now.UTC().Format("2006-01-02T15:04:05.000Z")

	// The stage name is validated above, so it is safe to splice into the JSON
	// path literal (a path placeholder is valid too, but a literal keeps the
	// statement trivially portable across MySQL 8.x versions).
	query = "UPDATE `PipelineJob` SET `metadata` = JSON_SET(" + metadataObject + ", '$.extraction', " +
		"JSON_SET(" + extractionObject + ", '$.stages', JSON_SET(" + stagesObject + ", '$.$STAGE', CAST(? AS JSON)), '$.updatedAt', ?)" +
		"), `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?"
	query = strings.Replace(query, "$STAGE", stage, 1)
	args = []any{string(entryJSON), updatedAtISO, now.UTC().Truncate(time.Millisecond), pipelineJobID, orgID}
	return query, args, true
}
