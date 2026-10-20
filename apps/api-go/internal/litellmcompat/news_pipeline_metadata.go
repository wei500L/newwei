package litellmcompat

// This file adds the metadata for the migrated news-pipeline LLM calls without
// touching the archive/classifier metadata types. The NestJS pipeline passes
// plain metadata objects like {jobId, source: "news-pipeline", feature: "clean"}
// (completion), {jobId, source, stage: "dedupe", threshold, promptVersion}
// (dedupe judge) and the optional frontier log metadata spread
// {runId?, nodeId?, profileId?} (repair). The object is an ordered extension
// leaf: callers append the members in the same order NestJS builds them so the
// upstream request body and the llmrequestlogs row keep the legacy field order.

import (
	"context"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// NewsPipelineMetadataField is one ordered metadata member. Exactly one of Text
// or Number is set.
type NewsPipelineMetadataField struct {
	Key    string
	Text   *string
	Number *float64
}

// NewsPipelineMetadata is the ordered metadata object of one pipeline call.
type NewsPipelineMetadata struct {
	OrgID  string
	Fields []NewsPipelineMetadataField
}

// NewNewsPipelineMetadata starts the object with the jobId and source members,
// the two members every pipeline call sets first.
func NewNewsPipelineMetadata(orgID, jobID string) NewsPipelineMetadata {
	metadata := NewsPipelineMetadata{OrgID: orgID}
	if jobID != "" {
		metadata.Fields = append(metadata.Fields, textMetadataField("jobId", jobID))
	}
	metadata.Fields = append(metadata.Fields, textMetadataField("source", "news-pipeline"))
	return metadata
}

// AddText appends one string member. Empty values keep the NestJS behaviour
// where undefined members are omitted from the metadata object.
func (m NewsPipelineMetadata) AddText(key, value string) NewsPipelineMetadata {
	if value == "" {
		return m
	}
	m.Fields = append(m.Fields, textMetadataField(key, value))
	return m
}

// AddNumber appends one numeric member.
func (m NewsPipelineMetadata) AddNumber(key string, value float64) NewsPipelineMetadata {
	copy := value
	m.Fields = append(m.Fields, NewsPipelineMetadataField{Key: key, Number: &copy})
	return m
}

// AddFrontierLogMetadata appends the resolveFrontierLogMetadata members in the
// NestJS spread order (runId, nodeId, profileId) when the crawl metadata carries
// them.
func (m NewsPipelineMetadata) AddFrontierLogMetadata(runID, nodeID, profileID string) NewsPipelineMetadata {
	m = m.AddText("runId", runID)
	m = m.AddText("nodeId", nodeID)
	return m.AddText("profileId", profileID)
}

// Feature is the first token used for the request-log feature column.
func (m NewsPipelineMetadata) Feature() string {
	for _, field := range m.Fields {
		if field.Key == "feature" && field.Text != nil {
			return *field.Text
		}
	}
	return ""
}

type newsPipelineMetadataJSON struct {
	JobID     string   `json:"jobId,omitempty"`
	Source    string   `json:"source"`
	Stage     string   `json:"stage,omitempty"`
	Feature   string   `json:"feature,omitempty"`
	Threshold *float64 `json:"threshold,omitempty"`
	PromptVer string   `json:"promptVersion,omitempty"`
	RunID     string   `json:"runId,omitempty"`
	NodeID    string   `json:"nodeId,omitempty"`
	ProfileID string   `json:"profileId,omitempty"`
	Layer     string   `json:"layer,omitempty"`
}

// JSONValue returns the ordered request metadata object sent upstream.
func (m NewsPipelineMetadata) JSONValue() any {
	var payload newsPipelineMetadataJSON
	for _, field := range m.Fields {
		switch field.Key {
		case "jobId":
			payload.JobID = textValue(field)
		case "source":
			payload.Source = textValue(field)
		case "stage":
			payload.Stage = textValue(field)
		case "feature":
			payload.Feature = textValue(field)
		case "layer":
			payload.Layer = textValue(field)
		case "promptVersion":
			payload.PromptVer = textValue(field)
		case "runId":
			payload.RunID = textValue(field)
		case "nodeId":
			payload.NodeID = textValue(field)
		case "profileId":
			payload.ProfileID = textValue(field)
		case "threshold":
			payload.Threshold = field.Number
		}
	}
	return payload
}

// LogFields returns the request-log metadata members in insertion order.
func (m NewsPipelineMetadata) LogFields() []llmlogs.ModelRequestMetadataField {
	if len(m.Fields) == 0 {
		return nil
	}
	fields := make([]llmlogs.ModelRequestMetadataField, 0, len(m.Fields)+1)
	fields = append(fields, textModelRequestField("orgId", m.OrgID))
	for _, field := range m.Fields {
		entry := llmlogs.ModelRequestMetadataField{Key: field.Key, Text: field.Text, Number: field.Number}
		fields = append(fields, entry)
	}
	return fields
}

func textMetadataField(key, value string) NewsPipelineMetadataField {
	copy := value
	return NewsPipelineMetadataField{Key: key, Text: &copy}
}

func textValue(field NewsPipelineMetadataField) string {
	if field.Text == nil {
		return ""
	}
	return *field.Text
}

func textModelRequestField(key, value string) llmlogs.ModelRequestMetadataField {
	copy := value
	return llmlogs.ModelRequestMetadataField{Key: key, Text: &copy}
}

// CompletionTimeoutMS reproduces LiteLlmService.getCompletionTimeoutMs: the
// resolved completion profile timeout in milliseconds.
func (c *Client) CompletionTimeoutMS(ctx context.Context) (int, error) {
	profile, err := c.resolveCompletion(ctx)
	if err != nil {
		return 0, err
	}
	timeout := profile.Timeout
	if timeout <= 0 {
		timeout = c.cfg.Timeout
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return int(timeout / time.Millisecond), nil
}
