package assistantwrite

import (
	"context"
	"errors"
	"strings"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/assistantruns"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
)

type resolvers struct {
	service *assistantruns.Service
}

// requestAssistantQuery decodes AssistantQueryInput, submits the run and
// returns the pending AssistantRunModel.
func (r *resolvers) requestAssistantQuery(ctx contract.Context) (history.AssistantRunModel, error) {
	input, err := decodeQueryInput(ctx.Args)
	if err != nil {
		return history.AssistantRunModel{}, err
	}
	run, err := r.service.SubmitQuery(callContext(ctx), ctx.Identity.OrgID, input, triggeredBy(ctx.Identity.UserID))
	if err != nil {
		return history.AssistantRunModel{}, mapFailure(err)
	}
	model := toModel(run)
	model.Input = input
	return model, nil
}

// requestAssistantReport decodes AssistantReportInput and submits the run.
func (r *resolvers) requestAssistantReport(ctx contract.Context) (history.AssistantRunModel, error) {
	input, err := decodeReportInput(ctx.Args)
	if err != nil {
		return history.AssistantRunModel{}, err
	}
	run, err := r.service.SubmitReport(callContext(ctx), ctx.Identity.OrgID, input, triggeredBy(ctx.Identity.UserID))
	if err != nil {
		return history.AssistantRunModel{}, mapFailure(err)
	}
	model := toModel(run)
	model.Input = input
	return model, nil
}

// requestAssistantForecast decodes AssistantForecastInput and submits the run.
func (r *resolvers) requestAssistantForecast(ctx contract.Context) (history.AssistantRunModel, error) {
	input, err := decodeForecastInput(ctx.Args)
	if err != nil {
		return history.AssistantRunModel{}, err
	}
	run, err := r.service.SubmitForecast(callContext(ctx), ctx.Identity.OrgID, input, triggeredBy(ctx.Identity.UserID))
	if err != nil {
		return history.AssistantRunModel{}, mapFailure(err)
	}
	model := toModel(run)
	model.Input = input
	return model, nil
}

// deleteAssistantRun trims the id, rejects an empty one and reports whether a
// row was deleted.
func (r *resolvers) deleteAssistantRun(ctx contract.Context) (bool, error) {
	runID, _ := contract.StringArg(ctx.Args, "runId")
	normalized := strings.TrimSpace(runID)
	if normalized == "" {
		return false, &contract.Failure{Status: 400, Message: "runId is required"}
	}
	deleted, err := r.service.DeleteRun(callContext(ctx), ctx.Identity.OrgID, normalized)
	if err != nil {
		return false, mapFailure(err)
	}
	return deleted, nil
}

// callContext mirrors the read packages: a missing request context falls back
// to the background context instead of panicking in the store.
func callContext(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
}

func triggeredBy(userID string) *string {
	if strings.TrimSpace(userID) == "" {
		return nil
	}
	return &userID
}

func toModel(run assistantruns.SubmittedRun) history.AssistantRunModel {
	model := history.AssistantRunModel{
		ID:             run.ID,
		Type:           string(run.Type),
		Status:         string(run.Status),
		CreatedAt:      run.CreatedAt,
		Summary:        nil,
		Error:          nil,
		Output:         nil,
		ConversationID: run.ConversationID,
	}
	return model
}

// mapFailure converts the business failure to the GraphQL failure contract.
// The code becomes extensions.appCode, matching the NestJS exception filter.
func mapFailure(err error) error {
	var failure *assistantruns.Failure
	if errors.As(err, &failure) {
		return &contract.Failure{Status: failure.Status, Message: failure.Message, AppCode: failure.Code}
	}
	return err
}

func decodeQueryInput(args map[string]any) (assistantruns.QueryInput, error) {
	record, ok := contract.MapArg(args, "input")
	if !ok {
		return assistantruns.QueryInput{}, &contract.Failure{Status: 400, Message: "input is required"}
	}
	message, ok := stringField(record, "message", true)
	if !ok {
		return assistantruns.QueryInput{}, &contract.Failure{Status: 400, Message: "message must be a string"}
	}
	conversationID, present, ok := optionalStringField(record, "conversationId")
	if !ok {
		return assistantruns.QueryInput{}, &contract.Failure{Status: 400, Message: "conversationId must be a string"}
	}
	if present {
		if length := len(utf16.Encode([]rune(conversationID))); length > 128 {
			return assistantruns.QueryInput{}, &contract.Failure{Status: 400, Message: "conversationId must be shorter than or equal to 128 characters"}
		}
		if !validConversationID(conversationID) {
			return assistantruns.QueryInput{}, &contract.Failure{Status: 400, Message: "conversationId must match /^[A-Za-z0-9:_-]+$/ regular expression"}
		}
	}
	knowledgeSource, _, _ := optionalStringField(record, "knowledgeSource")
	return assistantruns.QueryInput{
		Message:         message,
		ConversationID:  conversationID,
		KnowledgeSource: assistantruns.KnowledgeSource(knowledgeSource),
	}, nil
}

func decodeReportInput(args map[string]any) (assistantruns.ReportInput, error) {
	record, ok := contract.MapArg(args, "input")
	if !ok {
		return assistantruns.ReportInput{}, &contract.Failure{Status: 400, Message: "input is required"}
	}
	period, ok := stringField(record, "period", true)
	if !ok || (period != "daily" && period != "weekly") {
		return assistantruns.ReportInput{}, &contract.Failure{Status: 400, Message: "period must be one of the following values: daily, weekly"}
	}
	topic, present, ok := optionalStringField(record, "topic")
	if !ok {
		return assistantruns.ReportInput{}, &contract.Failure{Status: 400, Message: "topic must be a string"}
	}
	limit, hasLimit, ok := optionalIntField(record, "limit")
	if !ok {
		return assistantruns.ReportInput{}, &contract.Failure{Status: 400, Message: "limit must be an integer number"}
	}
	if hasLimit && limit < 1 {
		return assistantruns.ReportInput{}, &contract.Failure{Status: 400, Message: "limit must not be less than 1"}
	}
	input := assistantruns.ReportInput{Period: period}
	if present {
		input.Topic = &topic
	}
	if hasLimit {
		input.Limit = &limit
	}
	return input, nil
}

func decodeForecastInput(args map[string]any) (assistantruns.ForecastInput, error) {
	record, ok := contract.MapArg(args, "input")
	if !ok {
		return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "input is required"}
	}
	series, ok := stringField(record, "series", true)
	if !ok {
		return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "series must be a string"}
	}
	input := assistantruns.ForecastInput{Series: series}
	if lookback, present, ok := optionalIntField(record, "lookbackDays"); !ok {
		return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "lookbackDays must be an integer number"}
	} else if present {
		if lookback < 7 {
			return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "lookbackDays must not be less than 7"}
		}
		input.LookbackDays = &lookback
	}
	if sourceField, present, ok := optionalStringField(record, "sourceField"); !ok {
		return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "sourceField must be a string"}
	} else if present {
		input.SourceField = &sourceField
	}
	if seasonal, present, ok := optionalIntField(record, "seasonalPeriod"); !ok {
		return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "seasonalPeriod must be an integer number"}
	} else if present {
		if seasonal < 0 {
			return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "seasonalPeriod must not be less than 0"}
		}
		input.SeasonalPeriod = &seasonal
	}
	if confidence, present, ok := optionalFloatField(record, "confidenceLevel"); !ok {
		return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "confidenceLevel must be a number"}
	} else if present {
		if confidence < 0.5 {
			return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "confidenceLevel must not be less than 0.5"}
		}
		if confidence > 0.999 {
			return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "confidenceLevel must not be greater than 0.999"}
		}
		input.ConfidenceLevel = &confidence
	}
	if modelKind, present, ok := optionalStringField(record, "modelKind"); !ok {
		return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "modelKind must be a string"}
	} else if present {
		if modelKind != "ets" && modelKind != "arima" {
			return assistantruns.ForecastInput{}, &contract.Failure{Status: 400, Message: "modelKind must be one of the following values: ets, arima"}
		}
		input.ModelKind = &modelKind
	}
	return input, nil
}

// stringField reads a required or optional string. The ok result is false only
// when the value has the wrong JSON type.
func stringField(record map[string]any, name string, required bool) (string, bool) {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue {
		return "", !required
	}
	text, ok := value.(string)
	return text, ok
}

func optionalStringField(record map[string]any, name string) (string, bool, bool) {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue {
		return "", false, true
	}
	text, ok := value.(string)
	if !ok {
		return "", false, false
	}
	return text, true, true
}

func optionalIntField(record map[string]any, name string) (int, bool, bool) {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue {
		return 0, false, true
	}
	number, ok := contract.AsInt(value)
	return number, ok, ok
}

func optionalFloatField(record map[string]any, name string) (float64, bool, bool) {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue {
		return 0, false, true
	}
	number, ok := contract.AsFloat(value)
	return number, ok, ok
}

func validConversationID(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == ':' || r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}
