package workspacewrite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// The argument objects arrive as the executor's coerced GraphQL values, which
// is the protocol boundary: everything is converted into the named structs
// below before any business logic runs.
//
// class-validator only sees the top-level input object, exactly like the NestJS
// DTOs: UpsertDashboardInput.widgets has no @ValidateNested / @Type, so the
// nested DashboardWidgetInput constraints (IsObject, Min) never run and are not
// enforced here. The SDL still guarantees the nested Int, enum and non-null
// constraints through GraphQL validation.
//
// The message order follows the class-validator decorator application order,
// which is the reverse of the source order in the NestJS DTO. Properties are
// reported in source order.

// upsertDashboardInput is a validated UpsertDashboardInput.
type upsertDashboardInput struct {
	ID          *string
	Version     *int
	Name        string
	Slug        string
	Description *string
	DescSet     bool
	Theme       *string
	ThemeSet    bool
	Config      json.RawMessage
	Widgets     []dashboardWidgetInput
}

// dashboardWidgetInput is one validated DashboardWidgetInput. DataConfig and
// Options are already normalized to the `value ?? {}` write rule.
type dashboardWidgetInput struct {
	ID         *string
	Title      *string
	TitleSet   bool
	Type       string
	DataSource string
	DataConfig json.RawMessage
	LayoutX    int
	LayoutY    int
	LayoutW    int
	LayoutH    int
	SortOrder  *int
	Options    json.RawMessage
}

// alertChannelInput is a validated AlertChannelInput.
type alertChannelInput struct {
	Type     string
	Name     string
	Target   string
	IsActive *bool
	Config   json.RawMessage
}

// updateAlertChannelInput is a validated UpdateAlertChannelInput. The *Set
// flags distinguish an omitted property from an explicit null.
type updateAlertChannelInput struct {
	ID          string
	Name        *string
	NameSet     bool
	Target      *string
	TargetSet   bool
	IsActive    *bool
	IsActiveSet bool
	Config      json.RawMessage
	ConfigSet   bool
}

// updateAlertEventStatusInput is a validated UpdateAlertEventStatusInput.
type updateAlertEventStatusInput struct {
	EventID string
	Status  string
	Note    *string
	NoteSet bool
}

func parseUpsertDashboardInput(args map[string]any) (upsertDashboardInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return upsertDashboardInput{}, err
	}
	messages := []string{}
	id, _ := optionalStringField(raw, "id", 0, &messages)
	version, _ := optionalIntField(raw, "version", 0, true, &messages)
	name := requiredStringField(raw, "name", 0, &messages)
	slug := requiredStringField(raw, "slug", 0, &messages)
	description, descriptionSet := optionalStringField(raw, "description", 0, &messages)
	theme, themeSet := optionalStringField(raw, "theme", 0, &messages)
	config, configErr := optionalJSONObjectField(raw, "config", &messages)
	if configErr != nil {
		return upsertDashboardInput{}, configErr
	}
	widgets, widgetErr := dashboardWidgetList(raw, &messages)
	if widgetErr != nil {
		return upsertDashboardInput{}, widgetErr
	}
	if len(messages) > 0 {
		return upsertDashboardInput{}, newInputFailure(messages)
	}
	return upsertDashboardInput{
		ID:          id,
		Version:     version,
		Name:        name,
		Slug:        slug,
		Description: description,
		DescSet:     descriptionSet,
		Theme:       theme,
		ThemeSet:    themeSet,
		Config:      config,
		Widgets:     widgets,
	}, nil
}
func dashboardWidgetList(raw map[string]any, messages *[]string) ([]dashboardWidgetInput, error) {
	value, state := contract.Lookup(raw, "widgets")
	if state != contract.ArgValue {
		*messages = append(*messages, "widgets must be an array")
		return nil, nil
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, "widgets must be an array")
		return nil, nil
	}
	widgets := make([]dashboardWidgetInput, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			*messages = append(*messages, "each value in widgets must be an object")
			continue
		}
		widget, err := parseDashboardWidgetInput(entry, messages)
		if err != nil {
			return nil, err
		}
		widgets = append(widgets, widget)
	}
	return widgets, nil
}

func parseDashboardWidgetInput(raw map[string]any, messages *[]string) (dashboardWidgetInput, error) {
	id, _ := optionalStringField(raw, "id", 0, messages)
	title, titleSet := optionalStringField(raw, "title", 0, messages)
	kind := requiredStringField(raw, "type", 0, messages)
	dataSource := requiredStringField(raw, "dataSource", 0, messages)
	dataConfig, _, err := jsonField(raw, "dataConfig")
	if err != nil {
		return dashboardWidgetInput{}, err
	}
	layoutX := requiredIntField(raw, "layoutX", messages)
	layoutY := requiredIntField(raw, "layoutY", messages)
	layoutW := requiredIntField(raw, "layoutW", messages)
	layoutH := requiredIntField(raw, "layoutH", messages)
	// sortOrder keeps its DTO @Min(0) unenforced: the nested widget constraints
	// never run in NestJS, so a negative value is written instead of rejected.
	sortOrder, _ := optionalIntField(raw, "sortOrder", 0, false, messages)
	options, _, err := jsonField(raw, "options")
	if err != nil {
		return dashboardWidgetInput{}, err
	}
	return dashboardWidgetInput{
		ID:         id,
		Title:      title,
		TitleSet:   titleSet,
		Type:       kind,
		DataSource: dataSource,
		DataConfig: dataConfig,
		LayoutX:    layoutX,
		LayoutY:    layoutY,
		LayoutW:    layoutW,
		LayoutH:    layoutH,
		SortOrder:  sortOrder,
		Options:    options,
	}, nil
}

func parseAlertChannelInput(channelCtx context.Context, args map[string]any) (alertChannelInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return alertChannelInput{}, err
	}
	messages := []string{}
	kind := requiredStringField(raw, "type", 0, &messages)
	name := requiredStringField(raw, "name", 80, &messages)
	target := requiredStringField(raw, "target", 0, &messages)
	// The DTO declares @ValidateIf(type === webhook) @IsSafeUrl on target, so the
	// decorator validation (sync hostname check, then DNS) only runs for a
	// webhook and reports its bare reason. The service layer then re-checks the
	// trimmed value in normalizeChannelTarget.
	if kind == alertChannelWebhook && target != "" {
		if reason := dtoWebhookTargetReason(channelCtx, target); reason != "" {
			messages = append(messages, reason)
		}
	}
	isActive, _ := optionalBoolField(raw, "isActive", &messages)
	config, _, configErr := jsonField(raw, "config")
	if configErr != nil {
		return alertChannelInput{}, configErr
	}
	if len(messages) > 0 {
		return alertChannelInput{}, newInputFailure(messages)
	}
	return alertChannelInput{Type: kind, Name: name, Target: target, IsActive: isActive, Config: config}, nil
}

func parseUpdateAlertChannelInput(args map[string]any) (updateAlertChannelInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateAlertChannelInput{}, err
	}
	messages := []string{}
	id := requiredStringField(raw, "id", 0, &messages)
	name, nameSet := optionalStringField(raw, "name", 80, &messages)
	target, targetSet := optionalStringField(raw, "target", 0, &messages)
	isActive, isActiveSet := optionalBoolField(raw, "isActive", &messages)
	config, configSet, configErr := jsonField(raw, "config")
	if configErr != nil {
		return updateAlertChannelInput{}, configErr
	}
	if len(messages) > 0 {
		return updateAlertChannelInput{}, newInputFailure(messages)
	}
	return updateAlertChannelInput{
		ID:          id,
		Name:        name,
		NameSet:     nameSet,
		Target:      target,
		TargetSet:   targetSet,
		IsActive:    isActive,
		IsActiveSet: isActiveSet,
		Config:      config,
		ConfigSet:   configSet,
	}, nil
}

func parseUpdateAlertEventStatusInput(args map[string]any) (updateAlertEventStatusInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateAlertEventStatusInput{}, err
	}
	messages := []string{}
	eventID := requiredStringField(raw, "eventId", 0, &messages)
	status := requiredStringField(raw, "status", 0, &messages)
	note, noteSet := optionalStringField(raw, "note", 500, &messages)
	if len(messages) > 0 {
		return updateAlertEventStatusInput{}, newInputFailure(messages)
	}
	return updateAlertEventStatusInput{EventID: eventID, Status: status, Note: note, NoteSet: noteSet}, nil
}

func inputObject(args map[string]any) (map[string]any, error) {
	raw, ok := contract.MapArg(args, "input")
	if !ok {
		// GraphQL rejects a missing or wrongly typed input before the resolver;
		// this mirrors the ValidationPipe failure shape for an untyped value.
		return nil, newInputFailure([]string{"input must be an object"})
	}
	return raw, nil
}

// requiredStringArg reads a non-null String argument. GraphQL rejects a missing
// or null value before the resolver; the check only mirrors the ValidationPipe
// failure shape if that boundary is ever bypassed.
func requiredStringArg(args map[string]any, name string) (string, error) {
	value, state := contract.Lookup(args, name)
	if state != contract.ArgValue {
		return "", newInputFailure([]string{name + " must be a string"})
	}
	text, ok := value.(string)
	if !ok {
		return "", newInputFailure([]string{name + " must be a string"})
	}
	return text, nil
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

// optionalBoolField mirrors @IsOptional @IsBoolean.
func optionalBoolField(input map[string]any, name string, messages *[]string) (*bool, bool) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing {
		return nil, false
	}
	if state == contract.ArgNull {
		return nil, true
	}
	flag, ok := value.(bool)
	if !ok {
		*messages = append(*messages, name+" must be a boolean value")
		return nil, true
	}
	return &flag, true
}

// requiredIntField mirrors @IsInt on an SDL Int! field. For a nested widget
// field the value is already guaranteed by GraphQL; the check only guards the
// protocol boundary.
func requiredIntField(input map[string]any, name string, messages *[]string) int {
	number, ok := contract.IntArg(input, name)
	if !ok {
		*messages = append(*messages, name+" must be an integer number")
		return 0
	}
	return number
}

// optionalIntField mirrors @IsOptional @IsInt plus an optional @Min. The
// message order is Min before IsInt, the decorator application order.
func optionalIntField(input map[string]any, name string, minValue int, hasMin bool, messages *[]string) (*int, bool) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing {
		return nil, false
	}
	if state == contract.ArgNull {
		return nil, true
	}
	number, ok := contract.AsInt(value)
	if !ok {
		if hasMin {
			*messages = append(*messages, fmt.Sprintf("%s must not be less than %d", name, minValue))
		}
		*messages = append(*messages, name+" must be an integer number")
		return nil, true
	}
	if hasMin && number < minValue {
		*messages = append(*messages, fmt.Sprintf("%s must not be less than %d", name, minValue))
		return nil, true
	}
	return &number, true
}

// optionalJSONObjectField mirrors @IsOptional @IsObject. The leaf is returned
// as raw JSON; an absent or null value becomes an empty object, following the
// `input.config ?? {}` write rule.
func optionalJSONObjectField(input map[string]any, name string, messages *[]string) (json.RawMessage, error) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing || state == contract.ArgNull {
		return json.RawMessage("{}"), nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		*messages = append(*messages, name+" must be an object")
		return json.RawMessage("{}"), nil
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		*messages = append(*messages, name+" must be an object")
		return json.RawMessage("{}"), nil
	}
	return encoded, nil
}

// jsonField returns a JSON scalar leaf together with whether the property was
// supplied. It mirrors @IsOptional on a JSON scalar with no type constraint:
// the value is kept exactly as sent. An explicit null is supplied as an empty
// object, following the `value ?? {}` write rule.
func jsonField(input map[string]any, name string) (json.RawMessage, bool, error) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing {
		return json.RawMessage("{}"), false, nil
	}
	if state == contract.ArgNull {
		return json.RawMessage("{}"), true, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, true, errors.New("workspacewrite: invalid json argument")
	}
	return encoded, true, nil
}

// jsTrim mirrors String.prototype.trim.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

// isJSSpace matches String.prototype.trim: ASCII whitespace, U+FEFF, and Zs.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a'
	}
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
