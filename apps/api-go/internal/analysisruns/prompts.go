package analysisruns

// This file owns the six analysis prompt defaults, their nullish environment
// overrides and the JavaScript-compatible template renderer.

import (
	"bytes"
	"encoding/json"
	"regexp"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// The six defaults are copied verbatim from
// packages/config/src/prompts/analysis.ts. The ANALYSIS_PROMPT_* environment
// variables override the system/user template through nullish semantics: an
// absent variable uses the default, while a configured empty string is a real
// (empty) template.
var promptTemplates = struct {
	CorrelationSystem  string
	CorrelationUser    string
	AnomalySystem      string
	AnomalyUser        string
	GeoTransportSystem string
	GeoTransportUser   string
}{
	CorrelationSystem: "你是一位专业的金融数据分析师。请围绕数据关联与情绪总结，提供简洁可执行的输出。",
	CorrelationUser: joinPromptLines(
		"任务：分析以下数据之间的关联性",
		"经济指标：{{indicatorName}}，当前值 {{value}}，环比变化 {{changePercent}}%",
		"相关新闻：{{news}}",
		"时间范围：{{startDate}} 至 {{endDate}}",
		"",
		"输出要求：",
		"1. 数据关联性分析（200字以内）",
		"2. 关键驱动因素（3-5条）",
		"3. 情绪判断：积极/中性/消极",
		"4. 潜在影响预测（100字以内）",
	),
	AnomalySystem: "角色：金融数据异常分析专家。优先参考统计检测结果，再结合新闻与政策解释异常的可能原因，并输出可执行洞察。",
	AnomalyUser: joinPromptLines(
		"任务：解释以下数据异常的可能原因",
		"指标：{{metric}}",
		"异常时间：{{timestamp}}",
		"异常值：{{value}}（偏离均值 {{deviationPercent}}%）",
		"同期新闻：{{news}}",
		"相关政策：{{policies}}",
		"统计检测结果：",
		"{{statsSummary}}",
		"",
		"输出要求：",
		"1. 异常原因分析（3-5条，按可能性排序）",
		"2. 每条原因需引用具体新闻或政策依据",
		"3. 总结（50字以内）",
	),
	GeoTransportSystem: joinPromptLines(
		"你是地理运输态势分析师。",
		"只能基于提供的观测事实作答，不得虚构缺失数据。",
		"必须明确区分观察事实与推断判断。",
		"引用证据时优先写 objectKey、UTC 时间、坐标、速度、航向、高度或船型。",
		"如果数据不足，直接指出数据缺口与置信度限制。",
	),
	GeoTransportUser: joinPromptLines(
		"任务：分析下列飞机与船舶观测轨迹。",
		"运输类型：{{transportKinds}}",
		"时间范围：{{startDate}} 至 {{endDate}}",
		"视图边界：{{bbox}}",
		"重点对象：{{objectKeys}}",
		"",
		"结构化上下文：",
		"{{contextJson}}",
		"",
		"输出要求：",
		"1. 总体态势",
		"2. 重点飞机",
		"3. 重点船舶",
		"4. 航线与咽喉点",
		"5. 异常行为",
		"6. 置信度与数据缺口",
		"7. 下一步观察点",
	),
}

func joinPromptLines(lines ...string) string {
	var buffer bytes.Buffer
	for index, line := range lines {
		if index > 0 {
			buffer.WriteByte('\n')
		}
		buffer.WriteString(line)
	}
	return buffer.String()
}

var promptPlaceholder = regexp.MustCompile(`\{\{(\w+)\}\}`)

// renderPromptTemplate replaces every {{word}} with the variable value. A
// missing variable becomes the empty string; other placeholders are untouched.
func renderPromptTemplate(template string, variables map[string]string) string {
	return promptPlaceholder.ReplaceAllStringFunc(template, func(match string) string {
		submatch := promptPlaceholder.FindStringSubmatch(match)
		if len(submatch) != 2 {
			return match
		}
		return variables[submatch[1]]
	})
}

// PromptBuilder renders the three analysis prompts using the effective
// overrides captured from the environment.
type PromptBuilder struct {
	overrides PromptOverrides
}

// PromptOverrides are the six optional templates. A nil value means the
// variable was absent; a non-nil value is used verbatim, including "".
type PromptOverrides struct {
	CorrelationSystem  *string
	CorrelationUser    *string
	AnomalySystem      *string
	AnomalyUser        *string
	GeoTransportSystem *string
	GeoTransportUser   *string
}

// NewPromptBuilder captures the resolved prompt overrides.
func NewPromptBuilder(overrides PromptOverrides) *PromptBuilder {
	return &PromptBuilder{overrides: overrides}
}

func (b *PromptBuilder) correlationSystem() string {
	if b != nil && b.overrides.CorrelationSystem != nil {
		return *b.overrides.CorrelationSystem
	}
	return promptTemplates.CorrelationSystem
}

func (b *PromptBuilder) correlationUser() string {
	if b != nil && b.overrides.CorrelationUser != nil {
		return *b.overrides.CorrelationUser
	}
	return promptTemplates.CorrelationUser
}

func (b *PromptBuilder) anomalySystem() string {
	if b != nil && b.overrides.AnomalySystem != nil {
		return *b.overrides.AnomalySystem
	}
	return promptTemplates.AnomalySystem
}

func (b *PromptBuilder) anomalyUser() string {
	if b != nil && b.overrides.AnomalyUser != nil {
		return *b.overrides.AnomalyUser
	}
	return promptTemplates.AnomalyUser
}

func (b *PromptBuilder) geoTransportSystem() string {
	if b != nil && b.overrides.GeoTransportSystem != nil {
		return *b.overrides.GeoTransportSystem
	}
	return promptTemplates.GeoTransportSystem
}

func (b *PromptBuilder) geoTransportUser() string {
	if b != nil && b.overrides.GeoTransportUser != nil {
		return *b.overrides.GeoTransportUser
	}
	return promptTemplates.GeoTransportUser
}

// CorrelationMessages renders the correlation system/user pair. News items keep
// the input order and are numbered from one; an empty list uses 无相关新闻.
func (b *PromptBuilder) CorrelationMessages(input CorrelationInput) []publicportal.AnalysisMessage {
	news := "无相关新闻"
	if len(input.NewsSummaries) > 0 {
		lines := make([]string, 0, len(input.NewsSummaries))
		for index, summary := range input.NewsSummaries {
			lines = append(lines, integerString(index+1)+". "+summary)
		}
		news = joinPromptLines(lines...)
	}
	user := renderPromptTemplate(b.correlationUser(), map[string]string{
		"indicatorName": input.IndicatorName,
		"value":         jsNumberString(input.Value),
		"changePercent": jsNumberString(input.ChangePercent),
		"news":          news,
		"startDate":     input.StartDate,
		"endDate":       input.EndDate,
	})
	return []publicportal.AnalysisMessage{
		{Role: "system", Content: b.correlationSystem()},
		{Role: "user", Content: user},
	}
}

// AnomalyMessages renders the anomaly prompt and returns the full statistical
// findings plus the summary inserted into the prompt.
func (b *PromptBuilder) AnomalyMessages(input AnomalyInput) ([]publicportal.AnalysisMessage, []AnomalyFinding, string) {
	var series []SeriesPoint
	if input.Series != nil {
		series = *input.Series
	}
	findings := EvaluateSeries(series)
	statsSummary := "未检测到显著的统计异常"
	if len(findings) > 0 {
		lines := make([]string, 0, len(findings))
		for index, finding := range findings {
			lines = append(lines, integerString(index+1)+". "+finding.Reason+
				" | 值 "+jsNumberString(finding.Point.Value)+
				" @ "+finding.Point.Timestamp+
				" (score "+jsToFixed(finding.Score, 2)+")")
		}
		statsSummary = joinPromptLines(lines...)
	}
	news := "无相关新闻"
	if len(input.NewsList) > 0 {
		lines := make([]string, 0, len(input.NewsList))
		for index, item := range input.NewsList {
			lines = append(lines, integerString(index+1)+". "+item)
		}
		news = joinPromptLines(lines...)
	}
	policies := "无相关政策"
	if len(input.PolicyList) > 0 {
		lines := make([]string, 0, len(input.PolicyList))
		for index, item := range input.PolicyList {
			lines = append(lines, integerString(index+1)+". "+item)
		}
		policies = joinPromptLines(lines...)
	}
	user := renderPromptTemplate(b.anomalyUser(), map[string]string{
		"metric":           input.Metric,
		"timestamp":        input.Timestamp,
		"value":            jsNumberString(input.Value),
		"deviationPercent": jsNumberString(input.DeviationPercent),
		"news":             news,
		"policies":         policies,
		"statsSummary":     statsSummary,
	})
	return []publicportal.AnalysisMessage{
		{Role: "system", Content: b.anomalySystem()},
		{Role: "user", Content: user},
	}, findings, statsSummary
}

// GeoTransportMessages renders the geo prompt with the JSON.stringify(context,
// null, 2) structure. bbox and objectKeys use the same display fallbacks as the
// NestJS prompt service.
func (b *PromptBuilder) GeoTransportMessages(input GeoTransportInput, context GeoContext) []publicportal.AnalysisMessage {
	bbox := "未指定"
	if len(input.Bbox) > 0 {
		parts := make([]string, 0, len(input.Bbox))
		for _, value := range input.Bbox {
			parts = append(parts, jsNumberString(value))
		}
		bbox = joinWithCommaSpace(parts)
	}
	objectKeys := "自动选择"
	if len(input.ObjectKeys) > 0 {
		objectKeys = joinWithCommaSpace(input.ObjectKeys)
	}
	transportKinds := "aircraft, vessel"
	if len(input.TransportKinds) > 0 {
		transportKinds = joinWithCommaSpace(input.TransportKinds)
	}
	user := renderPromptTemplate(b.geoTransportUser(), map[string]string{
		"transportKinds": transportKinds,
		"startDate":      input.StartDate,
		"endDate":        input.EndDate,
		"bbox":           bbox,
		"objectKeys":     objectKeys,
		"contextJson":    contextJSON(context),
	})
	return []publicportal.AnalysisMessage{
		{Role: "system", Content: b.geoTransportSystem()},
		{Role: "user", Content: user},
	}
}

func joinWithCommaSpace(values []string) string {
	if len(values) == 0 {
		return ""
	}
	out := values[0]
	for _, value := range values[1:] {
		out += ", " + value
	}
	return out
}

func integerString(value int) string {
	// strconv.Itoa would be equivalent; keeping the JS number helper for one
	// formatting path avoids a second integer formatter.
	return jsNumberString(float64(value))
}

// contextJSON is JSON.stringify(context, null, 2) with JavaScript escaping: Go's
// default HTML escaping is disabled because it would change <, > and & inside
// object names or geocells.
func contextJSON(context GeoContext) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(context); err != nil {
		return "{}"
	}
	return trimTrailingNewline(buffer.String())
}

func trimTrailingNewline(value string) string {
	for len(value) > 0 && value[len(value)-1] == '\n' {
		value = value[:len(value)-1]
	}
	return value
}
