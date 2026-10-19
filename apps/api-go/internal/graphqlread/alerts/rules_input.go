package alerts

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// upsertAlertRuleInput is the validated UpsertAlertRuleInput. The *Set flag on
// description records whether the property was supplied at all, because the
// NestJS update branch has three states for it:
//
//   - omitted: Prisma's update skips the undefined field, so the stored
//     description is left untouched;
//   - explicit null: the field is written as NULL;
//   - a string: the field is overwritten.
//
// Every other property is overwritten with the DTO default when it is omitted
// or null, matching the `input.x ?? default` expressions in upsertRule.
type upsertAlertRuleInput struct {
	ID               *string
	Name             string
	Description      *string
	DescriptionSet   bool
	Severity         *string
	Status           *string
	MetricProvider   *string
	MetricSlug       string
	Operator         string
	ThresholdValue   *float64
	ThresholdLower   *float64
	ThresholdUpper   *float64
	ChangeWindowMin  *int
	CooldownSeconds  *int
	CheckIntervalSec *int
	ChannelIDs       []string
	// ChannelIDsSet is true when channelIds was supplied and is not null. An
	// empty list is supplied and clears every link; an omitted or null list
	// leaves the links untouched.
	ChannelIDsSet bool
	Metadata      json.RawMessage
}

// alertSeverityValues, alertStatusValues, alertProviderValues and
// alertOperatorValues are the SDL enum members. GraphQL validation rejects
// anything else before a resolver runs; the check here only keeps the protocol
// boundary honest.
var (
	alertSeverityValues = map[string]bool{"low": true, "medium": true, "high": true}
	alertStatusValues   = map[string]bool{"active": true, "paused": true, "draft": true, "archived": true}
	alertProviderValues = map[string]bool{
		"economic_data":      true,
		"system_event":       true,
		"pipeline_job":       true,
		"crawl_task":         true,
		"system_metric":      true,
		"economic_anomaly":   true,
		"entity_sentiment":   true,
		"entity_association": true,
		"realtime_signal":    true,
	}
	alertOperatorValues = map[string]bool{
		"gt": true, "gte": true, "lt": true, "lte": true, "eq": true,
		"outside_range": true, "within_range": true,
		"change_up_pct": true, "change_down_pct": true,
	}
)

func parseUpsertAlertRuleInput(args map[string]any) (upsertAlertRuleInput, error) {
	raw, ok := contract.MapArg(args, "input")
	if !ok {
		// GraphQL rejects a missing or wrongly typed input before the resolver;
		// this mirrors the ValidationPipe failure shape for an untyped value.
		return upsertAlertRuleInput{}, newInputFailure([]string{"input must be an object"})
	}
	messages := []string{}
	var input upsertAlertRuleInput
	id, _ := optionalStringField(raw, "id", 0, &messages)
	// upsertRule branches on `input.id ? ... : null`, so an empty string is the
	// create branch in NestJS; keep that JS truthiness instead of looking up "".
	if id != nil && *id == "" {
		id = nil
	}
	input.ID = id
	input.Name = requiredStringField(raw, "name", 120, &messages)
	input.Description, input.DescriptionSet = optionalStringField(raw, "description", 240, &messages)
	input.Severity = optionalEnumField(raw, "severity", alertSeverityValues, &messages)
	input.Status = optionalEnumField(raw, "status", alertStatusValues, &messages)
	input.MetricProvider = optionalEnumField(raw, "metricProvider", alertProviderValues, &messages)
	input.MetricSlug = requiredStringField(raw, "metricSlug", 0, &messages)
	input.Operator = requiredEnumField(raw, "operator", alertOperatorValues, &messages)
	input.ThresholdValue = optionalNumberField(raw, "thresholdValue", &messages)
	input.ThresholdLower = optionalNumberField(raw, "thresholdLower", &messages)
	input.ThresholdUpper = optionalNumberField(raw, "thresholdUpper", &messages)
	input.ChangeWindowMin = optionalPositiveIntField(raw, "changeWindowMin", &messages)
	input.CooldownSeconds = optionalPositiveIntField(raw, "cooldownSeconds", &messages)
	input.CheckIntervalSec = optionalPositiveIntField(raw, "checkIntervalSec", &messages)
	input.ChannelIDs, input.ChannelIDsSet = optionalStringListField(raw, "channelIds", &messages)
	metadata, err := jsonFieldValue(raw, "metadata")
	if err != nil {
		return upsertAlertRuleInput{}, err
	}
	input.Metadata = metadata
	if len(messages) > 0 {
		return upsertAlertRuleInput{}, newInputFailure(messages)
	}
	return input, nil
}

// newInputFailure is the class-validator / BadRequestException equivalent: the
// GlobalExceptionFilter joins the ValidationPipe array with "; ".
func newInputFailure(messages []string) error {
	return &contract.Failure{
		Message: strings.Join(messages, "; "),
		Status:  http.StatusBadRequest,
	}
}

func maxLengthMessage(name string, max int) string {
	return fmt.Sprintf("%s must be shorter than or equal to %d characters", name, max)
}

// requiredStringField mirrors @IsString plus an optional @MaxLength. max <= 0
// means the DTO declares no length constraint.
func requiredStringField(input map[string]any, name string, max int, messages *[]string) string {
	value, state := contract.Lookup(input, name)
	text, ok := value.(string)
	if state != contract.ArgValue || !ok {
		if max > 0 {
			*messages = append(*messages, maxLengthMessage(name, max))
		}
		*messages = append(*messages, name+" must be a string")
		return ""
	}
	if max > 0 && jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(name, max))
		return ""
	}
	return text
}

// optionalStringField mirrors @IsOptional @IsString plus an optional @MaxLength.
// It reports whether the property was supplied; an explicit null is supplied
// with a nil value.
func optionalStringField(input map[string]any, name string, max int, messages *[]string) (*string, bool) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing {
		return nil, false
	}
	if state == contract.ArgNull {
		return nil, true
	}
	text, ok := value.(string)
	if !ok {
		if max > 0 {
			*messages = append(*messages, maxLengthMessage(name, max))
		}
		*messages = append(*messages, name+" must be a string")
		return nil, true
	}
	if max > 0 && jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(name, max))
		return nil, true
	}
	return &text, true
}

// optionalEnumField mirrors @IsOptional @IsEnum. An explicit null is supplied
// with a nil value and is treated as "not provided" by the service defaults.
func optionalEnumField(input map[string]any, name string, allowed map[string]bool, messages *[]string) *string {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing || state == contract.ArgNull {
		return nil
	}
	text, ok := contract.AsString(value)
	if !ok || !allowed[text] {
		*messages = append(*messages, name+" must be one of the following values: "+enumValues(allowed))
		return nil
	}
	return &text
}

// requiredEnumField mirrors @IsEnum on a non-null SDL field. GraphQL rejects a
// missing or unknown member before the resolver; the check only guards the
// protocol boundary.
func requiredEnumField(input map[string]any, name string, allowed map[string]bool, messages *[]string) string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, name+" must be one of the following values: "+enumValues(allowed))
		return ""
	}
	text, ok := contract.AsString(value)
	if !ok || !allowed[text] {
		*messages = append(*messages, name+" must be one of the following values: "+enumValues(allowed))
		return ""
	}
	return text
}

// optionalNumberField mirrors @IsOptional @IsNumber on a GraphQL Float. An
// explicit null is kept as "not provided"; the service then writes null, which
// is the deliberate Q1 difference from NestJS's new Prisma.Decimal(null) throw.
func optionalNumberField(input map[string]any, name string, messages *[]string) *float64 {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing || state == contract.ArgNull {
		return nil
	}
	parsed, ok := contract.AsFloat(value)
	if !ok || !isFinite(parsed) {
		*messages = append(*messages, name+" must be a number conforming to the specified constraints")
		return nil
	}
	return &parsed
}

// optionalPositiveIntField mirrors @IsOptional @IsPositive on a GraphQL Int. The
// DTO has no @IsInt; the SDL already guarantees an integer.
func optionalPositiveIntField(input map[string]any, name string, messages *[]string) *int {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing || state == contract.ArgNull {
		return nil
	}
	parsed, ok := contract.AsInt(value)
	if !ok || parsed <= 0 {
		*messages = append(*messages, name+" must be a positive number")
		return nil
	}
	return &parsed
}

// optionalStringListField mirrors @IsOptional @IsArray @IsString({each:true}).
// An explicit null is treated like an omitted property: no links change.
func optionalStringListField(input map[string]any, name string, messages *[]string) ([]string, bool) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing || state == contract.ArgNull {
		return nil, false
	}
	items, ok := value.([]any)
	if !ok {
		if typed, already := value.([]string); already {
			return append([]string(nil), typed...), true
		}
		*messages = append(*messages, name+" must be an array")
		return nil, true
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			*messages = append(*messages, "each value in "+name+" must be a string")
			return nil, true
		}
		ids = append(ids, text)
	}
	return ids, true
}

// jsonFieldValue mirrors the `value ?? {}` write rule for the JSON scalar. The
// metadata leaf is stored as sent; an absent or explicit null metadata becomes
// an empty object.
func jsonFieldValue(input map[string]any, name string) (json.RawMessage, error) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing || state == contract.ArgNull {
		return json.RawMessage("{}"), nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, newInputFailure([]string{name + " must be a JSON value"})
	}
	return encoded, nil
}

func enumValues(allowed map[string]bool) string {
	values := make([]string, 0, len(allowed))
	for value := range allowed {
		values = append(values, value)
	}
	sort.Strings(values)
	return strings.Join(values, ", ")
}

// jsMaxLengthLen mirrors the validator.js isLength used by class-validator
// MaxLength: the UTF-16 length minus the surrogate pairs and the presentation
// sequences (a non-variation-selector rune followed by U+FE0F or U+FE0E).
func jsMaxLengthLen(text string) int {
	runes := []rune(text)
	count := len(runes)
	for index := 0; index < len(runes); index++ {
		if isVariationSelectorRune(runes[index]) {
			continue
		}
		if index+1 < len(runes) && isVariationSelectorRune(runes[index+1]) {
			count--
			index++
		}
	}
	return count
}

func isVariationSelectorRune(value rune) bool {
	return value == 0xFE0F || value == 0xFE0E
}
