package settingswrite

import (
	"fmt"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// This file reproduces the reachable part of the global ValidationPipe for the
// thirteen settings inputs. GraphQL itself already guarantees the scalar and
// list shapes of every argument, so only the constraints the SDL cannot express
// are checked here: @Min / @Max on numbers, @MaxLength on strings, the array
// size constraints and @IsIn / @IsEnum. Constraint messages use the
// class-validator default wording and are emitted in the decorator application
// order (the reverse of the source order), then joined with "; " exactly like
// GlobalExceptionFilter joins the ValidationPipe array.

// inputObject reads the single `input` argument.
func inputObject(args map[string]any) (map[string]any, error) {
	raw, ok := contract.MapArg(args, "input")
	if !ok {
		return nil, newInputFailure([]string{"input must be an object"})
	}
	return raw, nil
}

// maxLengthMessage is the class-validator @MaxLength default message.
func maxLengthMessage(name string, max int) string {
	return fmt.Sprintf("%s must be shorter than or equal to %d characters", name, max)
}

// eachMaxLengthMessage is the @MaxLength({ each: true }) default message.
func eachMaxLengthMessage(name string, max int) string {
	return fmt.Sprintf("each value in %s must be shorter than or equal to %d characters", name, max)
}

// arrayMaxSizeMessage is the @ArrayMaxSize default message.
func arrayMaxSizeMessage(name string, max int) string {
	return fmt.Sprintf("%s must contain not more than %d elements", name, max)
}

// arrayMinSizeMessage is the @ArrayMinSize default message.
func arrayMinSizeMessage(name string, min int) string {
	return fmt.Sprintf("%s must contain at least %d elements", name, min)
}

// inListMessage and eachInListMessage are the @IsIn / @IsEnum defaults.
func inListMessage(name string, allowed []string) string {
	return fmt.Sprintf("%s must be one of the following values: %s", name, strings.Join(allowed, ", "))
}

func eachInListMessage(name string, allowed []string) string {
	return fmt.Sprintf("each value in %s must be one of the following values: %s", name, strings.Join(allowed, ", "))
}

// requiredInt reads an Int! property constrained by @Min / @Max.
func requiredInt(input map[string]any, name string, min, max int, messages *[]string) int {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, fmtRangeMax(name, max), fmtRangeMin(name, min))
		return 0
	}
	number, ok := contract.AsInt(value)
	if !ok {
		*messages = append(*messages, fmtRangeMax(name, max), fmtRangeMin(name, min))
		return 0
	}
	if number > max {
		*messages = append(*messages, fmtRangeMax(name, max))
	}
	if number < min {
		*messages = append(*messages, fmtRangeMin(name, min))
	}
	return number
}

// optionalInt reads an Int property constrained by @IsOptional / @Min / @Max.
// A null value is accepted and reported as absent.
func optionalInt(input map[string]any, name string, min, max int, messages *[]string) *int {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return nil
	}
	number, ok := contract.AsInt(value)
	if !ok {
		*messages = append(*messages, fmtRangeMax(name, max), fmtRangeMin(name, min))
		return nil
	}
	if number > max {
		*messages = append(*messages, fmtRangeMax(name, max))
	}
	if number < min {
		*messages = append(*messages, fmtRangeMin(name, min))
	}
	return &number
}

// requiredFloat reads a Float! property constrained by @Min / @Max.
func requiredFloat(input map[string]any, name string, min, max float64, messages *[]string) float64 {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, fmtRangeMaxFloat(name, max), fmtRangeMinFloat(name, min))
		return 0
	}
	number, ok := contract.AsFloat(value)
	if !ok {
		*messages = append(*messages, fmtRangeMaxFloat(name, max), fmtRangeMinFloat(name, min))
		return 0
	}
	if number > max {
		*messages = append(*messages, fmtRangeMaxFloat(name, max))
	}
	if number < min {
		*messages = append(*messages, fmtRangeMinFloat(name, min))
	}
	return number
}

// optionalFloat reads a Float property constrained by @IsOptional / @Min / @Max.
func optionalFloat(input map[string]any, name string, min, max float64, messages *[]string) *float64 {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return nil
	}
	number, ok := contract.AsFloat(value)
	if !ok {
		*messages = append(*messages, fmtRangeMaxFloat(name, max), fmtRangeMinFloat(name, min))
		return nil
	}
	if number > max {
		*messages = append(*messages, fmtRangeMaxFloat(name, max))
	}
	if number < min {
		*messages = append(*messages, fmtRangeMinFloat(name, min))
	}
	return &number
}

// fmtRangeMaxFloat and fmtRangeMinFloat render the float bounds with the
// JavaScript number rendering class-validator interpolates.
func fmtRangeMaxFloat(field string, max float64) string {
	return fmt.Sprintf("%s must not be greater than %s", field, jsonFloat(max))
}

func fmtRangeMinFloat(field string, min float64) string {
	return fmt.Sprintf("%s must not be less than %s", field, jsonFloat(min))
}

// requiredBool reads a Boolean! property constrained by @IsBoolean.
func requiredBool(input map[string]any, name string, messages *[]string) bool {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, name+" must be a boolean value")
		return false
	}
	flag, ok := value.(bool)
	if !ok {
		*messages = append(*messages, name+" must be a boolean value")
		return false
	}
	return flag
}

// optionalBool reads a Boolean property constrained by @IsOptional / @IsBoolean.
func optionalBool(input map[string]any, name string, messages *[]string) *bool {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return nil
	}
	flag, ok := value.(bool)
	if !ok {
		*messages = append(*messages, name+" must be a boolean value")
		return nil
	}
	return &flag
}

// requiredStringMax reads a String! property constrained by @MaxLength only.
func requiredStringMax(input map[string]any, name string, max int, messages *[]string) string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, maxLengthMessage(name, max))
		return ""
	}
	text, ok := value.(string)
	if !ok {
		*messages = append(*messages, maxLengthMessage(name, max))
		return ""
	}
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(name, max))
	}
	return text
}

// optionalStringMax reads a String property constrained by @IsOptional /
// @IsString / @MaxLength. The second return value reports whether the property
// was supplied at all; an explicit null is supplied with a nil value.
func optionalStringMax(input map[string]any, name string, max int, messages *[]string) (*string, bool) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing {
		return nil, false
	}
	if state == contract.ArgNull {
		return nil, true
	}
	text, ok := value.(string)
	if !ok {
		*messages = append(*messages, maxLengthMessage(name, max), name+" must be a string")
		return nil, true
	}
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(name, max))
		return nil, true
	}
	return &text, true
}

// inList reads a String! property constrained by @IsIn.
func inList(input map[string]any, name string, allowed []string, messages *[]string) string {
	value, state := contract.Lookup(input, name)
	text, ok := "", false
	if state == contract.ArgValue {
		text, ok = value.(string)
	}
	if !ok {
		*messages = append(*messages, inListMessage(name, allowed))
		return ""
	}
	for _, candidate := range allowed {
		if text == candidate {
			return text
		}
	}
	*messages = append(*messages, inListMessage(name, allowed))
	return ""
}

// optionalInList reads an enum property constrained by @IsOptional / @IsEnum.
func optionalInList(input map[string]any, name string, allowed []string, messages *[]string) (*string, bool) {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return nil, state == contract.ArgNull
	}
	text, ok := value.(string)
	if !ok {
		*messages = append(*messages, inListMessage(name, allowed))
		return nil, true
	}
	for _, candidate := range allowed {
		if text == candidate {
			return &text, true
		}
	}
	*messages = append(*messages, inListMessage(name, allowed))
	return nil, true
}

// jsMaxLengthLen mirrors validator.js isLength, which class-validator's
// @MaxLength uses: the UTF-16 length minus surrogate pairs and presentation
// sequences (a base rune followed by U+FE0F / U+FE0E).
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

// jsTrim mirrors String.prototype.trim: ASCII whitespace plus the Unicode
// space separators and the zero-width no-break space.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a'
	}
}

// listAt returns the list entry at index as an object, mirroring the nested
// GraphQL input object the executor produces.
func listAt(list []any, index int) (map[string]any, bool) {
	if index < 0 || index >= len(list) {
		return nil, false
	}
	record, ok := list[index].(map[string]any)
	return record, ok
}
