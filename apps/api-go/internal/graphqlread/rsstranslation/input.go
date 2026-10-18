package rsstranslation

import (
	"fmt"
	"strings"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	domain "github.com/wei500L/newwei/apps/api-go/internal/rsstranslation"
)

// DTO constraints that the SDL does not carry and that the NestJS
// ValidationPipe enforces on TranslateRssItemsInput.
const (
	maxItemIDs              = 50
	maxFields               = 4
	maxTargetLanguageLength = 16
)

// inputFailure is the class-validator / BadRequestException equivalent for the
// decoded input.
type inputFailure struct {
	message string
}

func (e *inputFailure) Error() string { return e.message }

// decodeTranslateInput maps the untyped GraphQL input object onto the domain
// input and applies the DTO constraints in decorator order. itemIds is checked
// on the raw array length first, so deduplication can never let a larger input
// through.
func decodeTranslateInput(args map[string]any) (domain.TranslateInput, error) {
	raw, ok := contract.MapArg(args, "input")
	if !ok {
		return domain.TranslateInput{}, &inputFailure{message: "input must be an object"}
	}
	messages := []string{}
	itemIDs := decodeItemIDs(raw, &messages)
	fields := decodeFields(raw, &messages)
	provider := decodeProvider(raw, &messages)
	targetLanguage := decodeTargetLanguage(raw, &messages)
	if len(messages) > 0 {
		return domain.TranslateInput{}, &inputFailure{message: strings.Join(messages, "; ")}
	}
	return domain.TranslateInput{
		ItemIDs:        itemIDs,
		Provider:       provider,
		TargetLanguage: targetLanguage,
		Fields:         fields,
	}, nil
}

// decodeItemIDs mirrors @IsArray @ArrayMaxSize(50) @IsString({ each: true }).
func decodeItemIDs(input map[string]any, messages *[]string) []string {
	value, state := contract.Lookup(input, "itemIds")
	items, ok := value.([]any)
	if state != contract.ArgValue || !ok {
		*messages = append(*messages, "itemIds must be an array", arrayMaxSizeMessage("itemIds", maxItemIDs))
		return nil
	}
	if len(items) > maxItemIDs {
		*messages = append(*messages, arrayMaxSizeMessage("itemIds", maxItemIDs))
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			*messages = append(*messages, "each value in itemIds must be a string")
			continue
		}
		out = append(out, text)
	}
	return out
}

// decodeFields mirrors @IsOptional @IsArray @ArrayMaxSize(4)
// @IsEnum(RssTranslationField, { each: true }). An omitted or null list stays
// nil; the service turns an empty list into the default projection.
func decodeFields(input map[string]any, messages *[]string) []domain.Field {
	value, state := contract.Lookup(input, "fields")
	if state == contract.ArgMissing || state == contract.ArgNull {
		return nil
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, "fields must be an array")
		return nil
	}
	if len(items) > maxFields {
		*messages = append(*messages, arrayMaxSizeMessage("fields", maxFields))
	}
	out := make([]domain.Field, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok || !isTranslationField(text) {
			*messages = append(*messages, "each value in fields must be a valid enum value")
			continue
		}
		out = append(out, domain.Field(text))
	}
	return out
}

// decodeProvider reads the SDL-defaulted provider enum. The SDL rejects an
// explicit null and any value outside the enum before the resolver runs.
func decodeProvider(input map[string]any, messages *[]string) domain.Provider {
	value, state := contract.Lookup(input, "provider")
	if state != contract.ArgValue {
		return domain.ProviderDeepLx
	}
	text, ok := value.(string)
	if !ok || (text != string(domain.ProviderDeepLx) && text != string(domain.ProviderLLM)) {
		*messages = append(*messages, "provider must be a valid enum value")
		return domain.ProviderDeepLx
	}
	return domain.Provider(text)
}

// decodeTargetLanguage mirrors @IsString @MaxLength(16). An empty result lets
// the service apply the zh-CN default after trimming.
func decodeTargetLanguage(input map[string]any, messages *[]string) string {
	value, state := contract.Lookup(input, "targetLanguage")
	if state != contract.ArgValue {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		*messages = append(*messages, "targetLanguage must be a string")
		return ""
	}
	if jsMaxLengthLen(text) > maxTargetLanguageLength {
		*messages = append(*messages, maxLengthMessage("targetLanguage", maxTargetLanguageLength))
	}
	return text
}

func isTranslationField(value string) bool {
	switch domain.Field(value) {
	case domain.FieldTitle, domain.FieldSummary, domain.FieldKeyPoints, domain.FieldCleanedMarkdown:
		return true
	default:
		return false
	}
}

// arrayMaxSizeMessage is the @ArrayMaxSize default message.
func arrayMaxSizeMessage(name string, max int) string {
	return fmt.Sprintf("%s must contain not more than %d elements", name, max)
}

// maxLengthMessage is the @MaxLength default message.
func maxLengthMessage(name string, max int) string {
	return fmt.Sprintf("%s must be shorter than or equal to %d characters", name, max)
}

// jsMaxLengthLen is the JavaScript string length in UTF-16 code units.
func jsMaxLengthLen(value string) int {
	return len(utf16.Encode([]rune(value)))
}
