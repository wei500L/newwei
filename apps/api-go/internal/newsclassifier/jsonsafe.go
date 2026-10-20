package newsclassifier

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// stripMarkdownCodeFence reproduces llm-json.ts stripMarkdownCodeFence.
func stripMarkdownCodeFence(text string) string {
	trimmed := jsTrim(text)
	if !bytes.HasPrefix([]byte(trimmed), []byte("```")) {
		return trimmed
	}
	firstNewline := indexByteString(trimmed, '\n')
	if firstNewline == -1 {
		return trimmed
	}
	afterFence := trimmed[firstNewline+1:]
	closingFence := lastIndexSubstring(afterFence, "```")
	if closingFence == -1 {
		return trimmed
	}
	return jsTrim(afterFence[:closingFence])
}

// extractFirstJSON reproduces llm-json.ts extractFirstJson: find the first { or
// [, then scan with a string/escape aware bracket stack and return the first
// balanced object/array.
func extractFirstJSON(text string) (string, bool) {
	cleaned := stripMarkdownCodeFence(text)
	startObject := indexByteString(cleaned, '{')
	startArray := indexByteString(cleaned, '[')
	start := -1
	switch {
	case startObject == -1:
		start = startArray
	case startArray == -1:
		start = startObject
	case startObject < startArray:
		start = startObject
	default:
		start = startArray
	}
	if start == -1 {
		return "", false
	}

	stack := make([]byte, 0, 8)
	inString := false
	escaped := false
	for index := start; index < len(cleaned); index++ {
		char := cleaned[index]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
				continue
			}
			if char == '"' {
				inString = false
			}
			continue
		}
		switch char {
		case '"':
			inString = true
		case '{':
			stack = append(stack, '}')
		case '[':
			stack = append(stack, ']')
		case '}', ']':
			if len(stack) == 0 {
				return "", false
			}
			expected := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if expected != char {
				return "", false
			}
			if len(stack) == 0 {
				return jsTrim(cleaned[start : index+1]), true
			}
		}
	}
	return "", false
}

// SafeJSONParseFromText reproduces safeJsonParseFromText: extract the first JSON
// value and validate it; invalid JSON returns false.
func SafeJSONParseFromText(text string) (json.RawMessage, bool) {
	extracted, ok := extractFirstJSON(text)
	if !ok {
		return nil, false
	}
	if !json.Valid([]byte(extracted)) {
		return nil, false
	}
	return json.RawMessage(extracted), true
}

func indexByteString(value string, target byte) int {
	return bytes.IndexByte([]byte(value), target)
}

func lastIndexSubstring(value, target string) int {
	return bytes.LastIndex([]byte(value), []byte(target))
}

// rawLLMResponse and rawLLMCandidate mirror LlmClassificationResponseSchema.
// Missing members stay nil; wrong JSON types fail unmarshalling, which is the
// Zod validation failure branch.
type rawLLMResponse struct {
	Candidates *[]rawLLMCandidate `json:"candidates"`
	Rationale  *string            `json:"rationale"`
}

type rawLLMCandidate struct {
	Path   *string  `json:"path"`
	Score  *float64 `json:"score"`
	Reason *string  `json:"reason"`
}

// llmClassificationResponse is the validated response.
type llmClassificationResponse struct {
	Candidates []llmCandidate
	Rationale  *string
}

type llmCandidate struct {
	Path   string
	Score  float64
	Reason *string
}

// validateLLMClassificationResponse applies the Zod schema: 1..10 candidates,
// path min 1, score 0..1, reason max 240, rationale max 280. Unknown keys are
// ignored exactly like Zod's default object stripping.
func validateLLMClassificationResponse(raw json.RawMessage) (llmClassificationResponse, error) {
	var parsed rawLLMResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return llmClassificationResponse{}, err
	}
	if parsed.Candidates == nil || len(*parsed.Candidates) < 1 || len(*parsed.Candidates) > 10 {
		return llmClassificationResponse{}, errors.New("LLM classification candidates must contain 1..10 entries")
	}
	if parsed.Rationale != nil && utf16Length(*parsed.Rationale) > 280 {
		return llmClassificationResponse{}, errors.New("LLM classification rationale exceeds 280 characters")
	}
	out := llmClassificationResponse{
		Candidates: make([]llmCandidate, 0, len(*parsed.Candidates)),
		Rationale:  parsed.Rationale,
	}
	for index, candidate := range *parsed.Candidates {
		if candidate.Path == nil || *candidate.Path == "" {
			return llmClassificationResponse{}, fmt.Errorf("LLM classification candidate #%d path is required", index+1)
		}
		if candidate.Score == nil || *candidate.Score < 0 || *candidate.Score > 1 {
			return llmClassificationResponse{}, fmt.Errorf("LLM classification candidate #%d score must be within 0..1", index+1)
		}
		if candidate.Reason != nil && utf16Length(*candidate.Reason) > 240 {
			return llmClassificationResponse{}, fmt.Errorf("LLM classification candidate #%d reason exceeds 240 characters", index+1)
		}
		out.Candidates = append(out.Candidates, llmCandidate{
			Path:   *candidate.Path,
			Score:  *candidate.Score,
			Reason: candidate.Reason,
		})
	}
	return out, nil
}
