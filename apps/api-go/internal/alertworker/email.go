package alertworker

import (
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/jsnum"
)

// This file ports EmailService.buildAlertTemplate and
// buildAlertTextTemplate from apps/api/src/modules/email/email.service.ts.
//
// Byte-level facts taken from the two templates (od -c) and from Handlebars'
// default compiler:
//
//   - alert.hbs is:
//     <h3>告警触发：{{ruleName}}</h3>\n
//     <p>指标：{{metric}}</p>\n
//     <p>当前值：{{value}}{{#if changePercentLabel}}（变化：{{changePercentLabel}}%）{{/if}}</p>\n
//     <p>阈值：{{thresholdLabel}}</p>\n
//     <p>时间：{{triggeredAt}}</p>\n
//     {{#if message}}\n<p>详情：{{message}}</p>\n{{/if}}\n
//     alert.text.hbs is the same with the HTML tags removed.
//   - Both templates are compiled with plain Handlebars.compile(source), so the
//     default HTML escape map applies to EVERY {{...}} substitution, including
//     the text template and the numeric values (escaping a number is a no-op).
//     The map lives in alertHandlebarsEscaper below.
//   - The {{#if message}} open and {{/if}} close tags are standalone lines, so
//     Handlebars strips the surrounding whitespace: when message is falsy the
//     output ends right after the 时间 line's newline; when it is truthy one
//     <p>详情：...</p> (HTML) or 详情：... (text) line is inserted, followed by a
//     newline, and nothing else.
//   - {{value}} and {{thresholdLabel}} use the JS number ToString spelling
//     (jsnum.Format); the threshold falls back to the literal 未设置 only when
//     it is null/undefined, so a threshold of 0 is rendered as "0".
//   - changePercentLabel is changePercent.toFixed(2); the emptiness of that
//     string drives the inline {{#if}}, and "0.00" is truthy in JS.
//   - triggeredAt is already an ISO-8601 string produced by the caller from
//     event.triggeredAt.toISOString().
//
// Handlebars' #if follows JS truthiness for strings: nil, "" and false are
// falsy. The Go inputs are pointers, so a non-nil message pointing at "" must
// still suppress the detail line.

// AlertEmailInput are the values the alert email templates render.
type AlertEmailInput struct {
	// RuleName is the alert rule name shown in the heading.
	RuleName string
	// Metric is the metric slug shown in the 指标 line.
	Metric string
	// Value is the current metric value, rendered like JS String(value).
	Value float64
	// Threshold is the configured threshold, or nil for the 未设置 literal.
	Threshold *float64
	// TriggeredAt is the ISO-8601 timestamp supplied by the caller.
	TriggeredAt string
	// Message is the optional event detail; nil or "" suppresses its line.
	Message *string
	// ChangePercent enables the inline 变化 label when non-nil.
	ChangePercent *float64
}

// alertHandlebarsEscaper is the Handlebars default escape map. It is applied to
// every substitution in both templates, exactly like the compiled templates.
var alertHandlebarsEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&#x27;",
	"`", "&#x60;",
	"=", "&#x3D;",
)

// RenderAlertHTML renders alert.hbs byte-for-byte like Handlebars.
func RenderAlertHTML(input AlertEmailInput) string {
	var builder strings.Builder
	builder.WriteString("<h3>告警触发：")
	builder.WriteString(escapeAlertTemplateValue(input.RuleName))
	builder.WriteString("</h3>\n<p>指标：")
	builder.WriteString(escapeAlertTemplateValue(input.Metric))
	builder.WriteString("</p>\n<p>当前值：")
	builder.WriteString(escapeAlertTemplateValue(jsnum.Format(input.Value)))
	writeAlertChangePercent(&builder, input.ChangePercent)
	builder.WriteString("</p>\n<p>阈值：")
	builder.WriteString(escapeAlertTemplateValue(alertThresholdLabel(input.Threshold)))
	builder.WriteString("</p>\n<p>时间：")
	builder.WriteString(escapeAlertTemplateValue(input.TriggeredAt))
	builder.WriteString("</p>\n")
	if alertMessagePresent(input.Message) {
		builder.WriteString("<p>详情：")
		builder.WriteString(escapeAlertTemplateValue(*input.Message))
		builder.WriteString("</p>\n")
	}
	return builder.String()
}

// RenderAlertText renders alert.text.hbs byte-for-byte like Handlebars.
func RenderAlertText(input AlertEmailInput) string {
	var builder strings.Builder
	builder.WriteString("告警触发：")
	builder.WriteString(escapeAlertTemplateValue(input.RuleName))
	builder.WriteString("\n指标：")
	builder.WriteString(escapeAlertTemplateValue(input.Metric))
	builder.WriteString("\n当前值：")
	builder.WriteString(escapeAlertTemplateValue(jsnum.Format(input.Value)))
	writeAlertChangePercent(&builder, input.ChangePercent)
	builder.WriteString("\n阈值：")
	builder.WriteString(escapeAlertTemplateValue(alertThresholdLabel(input.Threshold)))
	builder.WriteString("\n时间：")
	builder.WriteString(escapeAlertTemplateValue(input.TriggeredAt))
	builder.WriteString("\n")
	if alertMessagePresent(input.Message) {
		builder.WriteString("详情：")
		builder.WriteString(escapeAlertTemplateValue(*input.Message))
		builder.WriteString("\n")
	}
	return builder.String()
}

// AlertEmailSubject is `[Alert] ${rule.name} triggered`. The subject is not a
// template substitution, so NestJS does not escape it.
func AlertEmailSubject(ruleName string) string {
	return "[Alert] " + ruleName + " triggered"
}

// writeAlertChangePercent renders the inline {{#if changePercentLabel}} block.
// A non-nil changePercent is always formatted, including zero, which produces
// the truthy string "0.00".
func writeAlertChangePercent(builder *strings.Builder, changePercent *float64) {
	if changePercent == nil {
		return
	}
	builder.WriteString("（变化：")
	builder.WriteString(escapeAlertTemplateValue(jsnum.ToFixed(*changePercent, 2)))
	builder.WriteString("%）")
}

// alertThresholdLabel mirrors `threshold ?? "未设置"`: only nil is replaced, so
// zero and other finite numbers keep their JS number spelling.
func alertThresholdLabel(threshold *float64) string {
	if threshold == nil {
		return "未设置"
	}
	return jsnum.Format(*threshold)
}

// alertMessagePresent mirrors the truthiness check of {{#if message}}: a nil
// pointer and an empty string are both falsy.
func alertMessagePresent(message *string) bool {
	return message != nil && *message != ""
}

// escapeAlertTemplateValue applies the Handlebars default HTML escape map.
func escapeAlertTemplateValue(value string) string {
	return alertHandlebarsEscaper.Replace(value)
}
