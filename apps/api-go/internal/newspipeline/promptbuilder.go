package newspipeline

// This file ports news-prompt.builder.ts: the prompt templates rendering with
// the JavaScript String.replace/$-pattern semantics, the untrusted-article
// wrapper and the response_format schema generated verbatim from
// zodToJsonSchema(CleanedNewsSchema, { $refStrategy: "none" }).

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// untrustedArticleTag is UNTRUSTED_ARTICLE_TAG.
const untrustedArticleTag = "untrusted_article"

// promptbuilderDefaultRemovedNoiseTypes is DEFAULT_REMOVED_NOISE_TYPES.
var promptbuilderDefaultRemovedNoiseTypes = []string{
	"nav",
	"header",
	"footer",
	"sidebar",
	"ads",
	"promo",
	"subscription",
	"social",
	"related_links",
	"comments",
	"legal",
	"cookie_banner",
	"author_bio",
	"tag_cloud",
	"unrelated",
	"garbled_text",
	"scripts",
	"tracking",
	"other",
}

// cleanedNewsJSONSchema is zodToJsonSchema(CleanedNewsSchema, {$refStrategy:
// "none"}) serialized exactly as zod-to-json-schema@3.24.6 emits it (draft-07,
// properties in schema declaration order, required only cleaned_markdown).
const cleanedNewsJSONSchema = `{"type":"object","properties":{"title":{"type":["string","null"]},"subtitle":{"type":["string","null"]},"author":{"type":["string","null"]},"source":{"type":["string","null"]},"published_at":{"type":["string","null"]},"language":{"type":["string","null"]},"location":{"type":["string","null"]},"category":{"type":["string","null"]},"content_type":{"type":["string","null"]},"category_path":{"type":["string","null"]},"category_labels":{"type":"array","items":{"type":"string","minLength":1},"default":[]},"category_confidence":{"anyOf":[{"type":"number","minimum":0,"maximum":1},{"type":"null"}]},"category_reason":{"type":["string","null"]},"category_method":{"type":["string","null"]},"category_candidates":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string","minLength":1},"score":{"type":"number","minimum":0,"maximum":1},"legacy_category":{"type":"string","minLength":1},"reason":{"type":["string","null"]}},"required":["path","score","legacy_category"],"additionalProperties":false},"default":[]},"sentiment":{"type":["string","null"]},"sentiment_label":{"type":["string","null"]},"topics":{"type":"array","items":{"type":"string","minLength":1},"default":[]},"summary":{"type":["string","null"]},"key_points":{"type":"array","items":{"type":"string","minLength":1},"default":[]},"entities":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string","minLength":1},"type":{"type":"string","minLength":1},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["name","type","confidence"],"additionalProperties":false},"default":[]},"kg_relations":{"type":"array","items":{"type":"object","properties":{"subject":{"type":"object","properties":{"name":{"type":"string","minLength":1},"type":{"type":"string","minLength":1}},"required":["name","type"],"additionalProperties":false},"predicate":{"type":"string","minLength":1},"object":{"type":"object","properties":{"name":{"type":"string","minLength":1},"type":{"type":"string","minLength":1}},"required":["name","type"],"additionalProperties":false},"confidence":{"type":"number","minimum":0,"maximum":1},"properties":{"type":"object","additionalProperties":{}},"evidence":{"type":["string","null"]}},"required":["subject","predicate","object","confidence"],"additionalProperties":false},"default":[]},"stage_meta":{"type":"object","properties":{"preflight":{"type":"object","properties":{"status":{"type":"string","enum":["completed","skipped","rejected","failed"]},"provider":{"type":["string","null"]},"reason":{"type":["string","null"]},"model":{"type":["string","null"]},"prompt_version":{"type":["string","null"]},"prompt_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"completion_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"total_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"cost_usd":{"anyOf":[{"type":"number"},{"type":"null"}]},"latency_ms":{"anyOf":[{"type":"number"},{"type":"null"}]}},"required":["status"],"additionalProperties":false},"clean":{"type":"object","properties":{"status":{"type":"string","enum":["completed","skipped","rejected","failed"]},"provider":{"type":["string","null"]},"reason":{"type":["string","null"]},"model":{"type":["string","null"]},"prompt_version":{"type":["string","null"]},"prompt_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"completion_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"total_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"cost_usd":{"anyOf":[{"type":"number"},{"type":"null"}]},"latency_ms":{"anyOf":[{"type":"number"},{"type":"null"}]}},"required":["status"],"additionalProperties":false},"quality_gate":{"type":"object","properties":{"status":{"type":"string","enum":["completed","skipped","rejected","failed"]},"provider":{"type":["string","null"]},"reason":{"type":["string","null"]},"model":{"type":["string","null"]},"prompt_version":{"type":["string","null"]},"prompt_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"completion_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"total_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"cost_usd":{"anyOf":[{"type":"number"},{"type":"null"}]},"latency_ms":{"anyOf":[{"type":"number"},{"type":"null"}]}},"required":["status"],"additionalProperties":false},"entities":{"type":"object","properties":{"status":{"type":"string","enum":["completed","skipped","rejected","failed"]},"provider":{"type":["string","null"]},"reason":{"type":["string","null"]},"model":{"type":["string","null"]},"prompt_version":{"type":["string","null"]},"prompt_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"completion_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"total_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"cost_usd":{"anyOf":[{"type":"number"},{"type":"null"}]},"latency_ms":{"anyOf":[{"type":"number"},{"type":"null"}]}},"required":["status"],"additionalProperties":false},"sentiment":{"type":"object","properties":{"status":{"type":"string","enum":["completed","skipped","rejected","failed"]},"provider":{"type":["string","null"]},"reason":{"type":["string","null"]},"model":{"type":["string","null"]},"prompt_version":{"type":["string","null"]},"prompt_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"completion_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"total_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"cost_usd":{"anyOf":[{"type":"number"},{"type":"null"}]},"latency_ms":{"anyOf":[{"type":"number"},{"type":"null"}]}},"required":["status"],"additionalProperties":false},"kg":{"type":"object","properties":{"status":{"type":"string","enum":["completed","skipped","rejected","failed"]},"provider":{"type":["string","null"]},"reason":{"type":["string","null"]},"model":{"type":["string","null"]},"prompt_version":{"type":["string","null"]},"prompt_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"completion_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"total_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"cost_usd":{"anyOf":[{"type":"number"},{"type":"null"}]},"latency_ms":{"anyOf":[{"type":"number"},{"type":"null"}]}},"required":["status"],"additionalProperties":false},"classify":{"type":"object","properties":{"status":{"type":"string","enum":["completed","skipped","rejected","failed"]},"provider":{"type":["string","null"]},"reason":{"type":["string","null"]},"model":{"type":["string","null"]},"prompt_version":{"type":["string","null"]},"prompt_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"completion_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"total_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"cost_usd":{"anyOf":[{"type":"number"},{"type":"null"}]},"latency_ms":{"anyOf":[{"type":"number"},{"type":"null"}]}},"required":["status"],"additionalProperties":false},"dedupe":{"type":"object","properties":{"status":{"type":"string","enum":["completed","skipped","rejected","failed"]},"provider":{"type":["string","null"]},"reason":{"type":["string","null"]},"model":{"type":["string","null"]},"prompt_version":{"type":["string","null"]},"prompt_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"completion_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"total_tokens":{"anyOf":[{"type":"number"},{"type":"null"}]},"cost_usd":{"anyOf":[{"type":"number"},{"type":"null"}]},"latency_ms":{"anyOf":[{"type":"number"},{"type":"null"}]}},"required":["status"],"additionalProperties":false}},"additionalProperties":false},"cleaned_markdown":{"type":"string","minLength":1},"cleaned_markdown_source":{"type":"string","enum":["llm","crawl_fallback"]},"removed_noise_types":{"type":"array","items":{"type":"string","minLength":1},"default":[]},"quality_score":{"anyOf":[{"type":"number","minimum":0,"maximum":1},{"type":"null"}]},"llm_model":{"type":["string","null"]},"llm_prompt_version":{"type":["string","null"]}},"required":["cleaned_markdown"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}`

// PromptInput is the clean stage user prompt input.
type PromptInput struct {
	URL          string
	Markdown     string
	Metadata     json.RawMessage
	Keywords     []string
	SummaryHints []string
	Language     *string
	CacheHit     bool
}

// PromptBuilder renders the configurable prompt templates.
type PromptBuilder struct{}

// NewPromptBuilder builds a prompt builder.
func NewPromptBuilder() *PromptBuilder { return &PromptBuilder{} }

// WrapUntrustedArticle is wrapUntrustedArticle: the closing tag inside the
// content is defused, then the content is wrapped.
func WrapUntrustedArticle(content string) string {
	safe := strings.ReplaceAll(content, "</"+untrustedArticleTag+">", "</ "+untrustedArticleTag+">")
	return "<" + untrustedArticleTag + ">\n" + safe + "\n</" + untrustedArticleTag + ">"
}

// BuildSystemPrompt is buildSystemPrompt.
func (b *PromptBuilder) BuildSystemPrompt(config PromptConfig, language *string) string {
	languageHint := ""
	if language != nil && *language != "" {
		languageHint = "All free-text fields should use " + *language + "."
	}
	return promptbuilderRenderTemplate(config.SystemPromptTemplate, []promptbuilderTemplateValue{
		{name: "language_hint", value: languageHint},
	})
}

// BuildDenoisePrompt is buildDenoisePrompt.
func (b *PromptBuilder) BuildDenoisePrompt(config PromptConfig) string {
	return promptbuilderRenderTemplate(config.DenoisePromptTemplate, []promptbuilderTemplateValue{
		{name: "noise_type_list", value: strings.Join(promptbuilderDefaultRemovedNoiseTypes, ", ")},
	})
}

// BuildUserPrompt is buildUserPrompt.
func (b *PromptBuilder) BuildUserPrompt(config PromptConfig, input PromptInput) string {
	metadataSection := ""
	if input.Metadata != nil {
		if object, ok := contentParseOrderedJSON(input.Metadata); ok && len(object.keys) > 0 {
			metadataSection = "Metadata: " + string(object.marshal())
		}
	}
	keywordsSection := ""
	if len(input.Keywords) > 0 {
		keywordsSection = "Focus topics: " + strings.Join(input.Keywords, ", ")
	}
	summaryHintsSection := ""
	if len(input.SummaryHints) > 0 {
		summaryHintsSection = "Summary hints: " + strings.Join(input.SummaryHints, "; ")
	}

	rendered := promptbuilderRenderTemplate(config.UserPromptTemplate, []promptbuilderTemplateValue{
		{name: "url", value: input.URL},
		{name: "cache_hit", value: promptbuilderYesNo(input.CacheHit)},
		{name: "metadata_section", value: metadataSection},
		{name: "keywords_section", value: keywordsSection},
		{name: "summary_hints_section", value: summaryHintsSection},
		{name: "markdown", value: WrapUntrustedArticle(input.Markdown)},
	})
	return promptbuilderSquashEmptyLines(rendered)
}

// BuildResponseFormat is buildResponseFormat: the CleanedNewsSchema JSON schema
// wrapped in the OpenAI json_schema response format.
func (b *PromptBuilder) BuildResponseFormat() *litellmcompat.ResponseFormat {
	return &litellmcompat.ResponseFormat{
		Type: "json_schema",
		JSONSchema: &litellmcompat.JSONSchemaFormat{
			Name:   "clean_news_payload",
			Schema: json.RawMessage(cleanedNewsJSONSchema),
		},
	}
}

// BuildEntityPrompt is buildEntityPrompt.
func (b *PromptBuilder) BuildEntityPrompt(config PromptConfig, input EnrichmentInput) string {
	return promptbuilderRenderStagePrompt(config.EntityUserPromptTemplate, input)
}

// BuildSentimentPrompt is buildSentimentPrompt.
func (b *PromptBuilder) BuildSentimentPrompt(config PromptConfig, input EnrichmentInput) string {
	return promptbuilderRenderStagePrompt(config.SentimentUserPromptTemplate, input)
}

// BuildKgPrompt is buildKgPrompt.
func (b *PromptBuilder) BuildKgPrompt(config PromptConfig, input EnrichmentInput) string {
	return promptbuilderRenderStagePrompt(config.KGUserPromptTemplate, input)
}

func promptbuilderYesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

// promptbuilderTemplateValue is one template placeholder.
type promptbuilderTemplateValue struct {
	name  string
	value string
}

// promptbuilderRenderTemplate replaces {{ name }} placeholders in context order
// with the JavaScript replace() semantics (including $ replacement patterns).
func promptbuilderRenderTemplate(template string, context []promptbuilderTemplateValue) string {
	rendered := template
	for _, entry := range context {
		pattern := regexp.MustCompile(`(?i)\{\{\s*` + entry.name + `\s*\}\}`)
		rendered = promptbuilderJSReplaceAll(rendered, pattern, entry.value)
	}
	return rendered
}

// promptbuilderRenderStagePrompt is renderStagePrompt.
func promptbuilderRenderStagePrompt(template string, input EnrichmentInput) string {
	title := ""
	if input.Title != nil {
		title = *input.Title
	}
	summary := ""
	if input.Summary != nil {
		summary = *input.Summary
	}
	language := ""
	if input.Language != nil {
		language = *input.Language
	}
	rendered := promptbuilderRenderTemplate(template, []promptbuilderTemplateValue{
		{name: "title", value: title},
		{name: "summary", value: summary},
		{name: "markdown", value: WrapUntrustedArticle(input.Markdown)},
		{name: "language", value: language},
	})
	return promptbuilderSquashEmptyLines(rendered)
}

// promptbuilderJSReplaceAll is String.prototype.replace with a global regexp and
// a string replacement: it expands the $$, $&, $` and $' patterns of the
// replacement text per match. There are no capture groups in the templates, so
// $1-style patterns stay literal exactly like JavaScript leaves them when the
// group does not exist.
func promptbuilderJSReplaceAll(input string, pattern *regexp.Regexp, replacement string) string {
	if !strings.Contains(replacement, "$") {
		return pattern.ReplaceAllStringFunc(input, func(string) string { return replacement })
	}
	matches := pattern.FindAllStringIndex(input, -1)
	if len(matches) == 0 {
		return input
	}
	var builder strings.Builder
	last := 0
	for _, match := range matches {
		builder.WriteString(input[last:match[0]])
		builder.WriteString(promptbuilderExpandJSReplacement(replacement, input, match[0], match[1]))
		last = match[1]
	}
	builder.WriteString(input[last:])
	return builder.String()
}

// promptbuilderExpandJSReplacement expands the replacement patterns.
func promptbuilderExpandJSReplacement(replacement, input string, matchStart, matchEnd int) string {
	var builder strings.Builder
	for index := 0; index < len(replacement); index++ {
		character := replacement[index]
		if character != '$' || index+1 >= len(replacement) {
			builder.WriteByte(character)
			continue
		}
		next := replacement[index+1]
		switch next {
		case '$':
			builder.WriteByte('$')
			index++
		case '&':
			builder.WriteString(input[matchStart:matchEnd])
			index++
		case '`':
			builder.WriteString(input[:matchStart])
			index++
		case '\'':
			builder.WriteString(input[matchEnd:])
			index++
		default:
			// No capture groups exist in the templates, so $n / $<name> stay
			// literal.
			builder.WriteByte(character)
		}
	}
	return builder.String()
}

// promptbuilderSquashEmptyLines is squashEmptyLines: trim line ends, drop a
// blank line when the previous line was already blank, then trim the result.
func promptbuilderSquashEmptyLines(input string) string {
	lines := strings.Split(input, "\n")
	trimmed := make([]string, len(lines))
	for index, line := range lines {
		trimmed[index] = strings.TrimRightFunc(line, promptbuilderIsJSWhitespace)
	}
	out := make([]string, 0, len(trimmed))
	for index, line := range trimmed {
		currentEmpty := promptbuilderTrimJS(line) == ""
		previousEmpty := index > 0 && promptbuilderTrimJS(trimmed[index-1]) == ""
		if currentEmpty && previousEmpty {
			continue
		}
		out = append(out, line)
	}
	return promptbuilderTrimJS(strings.Join(out, "\n"))
}

// promptbuilderTrimJS is String.prototype.trim.
func promptbuilderTrimJS(value string) string {
	return strings.TrimFunc(value, promptbuilderIsJSWhitespace)
}

// promptbuilderIsJSWhitespace reports the characters String.prototype.trim
// strips.
func promptbuilderIsJSWhitespace(r rune) bool {
	return r == '\uFEFF' || unicode.IsSpace(r)
}
