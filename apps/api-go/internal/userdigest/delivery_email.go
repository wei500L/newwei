package userdigest

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

const (
	digestConsoleDefaultBaseURL = "http://localhost:3000"
	digestLinkPath              = "/today"
	digestDefaultSummary        = "暂无摘要。"
)

// deliveryScheduleConfig is the schedule part of the email payload. It mirrors
// DeliveryScheduleConfig in the NestJS delivery service.
type deliveryScheduleConfig struct {
	Timezone   string
	SendHour   int
	SendMinute int
}

// digestEmailEvent is one event row of the digest email templates.
type digestEmailEvent struct {
	Title          string
	Summary        string
	ItemCount      int
	UpdatedAtLabel string
	Link           string
}

// handlebarsEscaper reproduces the Handlebars default escape map. Both the HTML
// and the text template are compiled with Handlebars, so both escape the same
// characters.
var handlebarsEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&#x27;",
	"`", "&#x60;",
	"=", "&#x3D;",
)

// buildDigestEmail renders the user-digest HTML and text templates and returns
// the exact MailMessage the reused SMTP port sends. The recipient name falls
// back to the email when the first name is empty.
func buildDigestEmail(digest Digest, config deliveryScheduleConfig, firstName, targetEmail, consoleBaseURL string) authlogin.MailMessage {
	baseURL := strings.TrimSpace(consoleBaseURL)
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "" {
		baseURL = digestConsoleDefaultBaseURL
	}
	digestLink := baseURL + digestLinkPath

	location := deliveryLocation(config.Timezone)
	generatedAt := parseDigestTime(digest.GeneratedAt)
	subjectDate := generatedAt.In(location).Format("2006/01/02")
	recipientName := strings.TrimSpace(firstName)
	if recipientName == "" {
		recipientName = targetEmail
	}
	windowLabel := fmt.Sprintf("%d 天", digest.Preference.WindowDays)
	generatedAtLabel := formatZHDigestTime(generatedAt, location)

	events := make([]digestEmailEvent, 0, len(digest.Events))
	for _, event := range digest.Events {
		events = append(events, digestEmailEvent{
			Title:          digestEventTitle(event),
			Summary:        digestEventSummary(event),
			ItemCount:      event.ItemCount,
			UpdatedAtLabel: digestEventTimeLabel(event.LastAt, location),
			Link:           digestEventLink(event.RepresentativeURL, digestLink),
		})
	}

	subject := "每日摘要｜" + subjectDate
	return authlogin.MailMessage{
		To:      targetEmail,
		Subject: subject,
		HTML:    renderDigestHTML(recipientName, generatedAtLabel, windowLabel, len(events), digestLink, events),
		Text:    renderDigestText(recipientName, generatedAtLabel, windowLabel, len(events), digestLink, events),
	}
}

// deliveryLocation resolves the schedule timezone. A stored timezone is already
// validated at write time; UTC is only a last-resort fallback.
func deliveryLocation(name string) *time.Location {
	location, err := time.LoadLocation(strings.TrimSpace(name))
	if err != nil {
		return time.UTC
	}
	return location
}

// parseDigestTime parses the ISO generatedAt of the digest. The fallback keeps
// the email buildable if a caller passes a non-ISO value.
func parseDigestTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Now().UTC()
	}
	return parsed.UTC()
}

// formatZHDigestTime mirrors Intl.DateTimeFormat("zh-CN", { dateStyle:"medium",
// timeStyle:"short" }) for the generated-at and event labels.
func formatZHDigestTime(value time.Time, location *time.Location) string {
	local := value.In(location)
	return fmt.Sprintf("%d年%d月%d日 %02d:%02d", local.Year(), int(local.Month()), local.Day(), local.Hour(), local.Minute())
}

// digestEventTimeLabel mirrors the NestJS formatDate over event.lastAt: an
// unparseable value is returned unchanged, matching the Intl catch branch.
func digestEventTimeLabel(value string, location *time.Location) string {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return value
	}
	return formatZHDigestTime(parsed.UTC(), location)
}

// digestEventTitle mirrors the NestJS fallback chain
// title -> primaryEntity -> primaryTopic -> eventId.
func digestEventTitle(event Event) string {
	if value := trimmedPointer(event.Title); value != "" {
		return value
	}
	if value := trimmedPointer(event.PrimaryEntity); value != "" {
		return value
	}
	if value := trimmedPointer(event.PrimaryTopic); value != "" {
		return value
	}
	return event.EventID
}

// digestEventSummary mirrors `event.summary?.trim() || "暂无摘要。"`.
func digestEventSummary(event Event) string {
	if value := trimmedPointer(event.Summary); value != "" {
		return value
	}
	return digestDefaultSummary
}

// digestEventLink mirrors toSafeHttpUrl: only absolute http/https URLs survive,
// otherwise the Today page link is used.
func digestEventLink(representativeURL *string, fallback string) string {
	if representativeURL == nil {
		return fallback
	}
	raw := strings.TrimSpace(*representativeURL)
	if raw == "" {
		return fallback
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fallback
	}
	scheme := strings.ToLower(parsed.Scheme)
	if (scheme != "http" && scheme != "https") || parsed.Host == "" {
		return fallback
	}
	return parsed.String()
}

// trimmedPointer returns the trimmed value of a nullable string.
func trimmedPointer(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

// renderDigestHTML renders user-digest.hbs with Handlebars-equivalent escaping.
func renderDigestHTML(recipientName, generatedAtLabel, windowLabel string, eventCount int, digestLink string, events []digestEmailEvent) string {
	var builder strings.Builder
	builder.WriteString("<html lang=\"zh-CN\">\n")
	builder.WriteString("  <head>\n")
	builder.WriteString("    <meta charset=\"utf-8\" />\n")
	builder.WriteString("    <title>每日摘要</title>\n")
	builder.WriteString("  </head>\n")
	builder.WriteString("  <body\n")
	builder.WriteString("    style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a; line-height: 1.6;\"\n")
	builder.WriteString("  >\n")
	fmt.Fprintf(&builder, "    <h2 style=\"margin: 0 0 12px;\">%s，你的每日摘要已生成</h2>\n", handlebarsEscaper.Replace(recipientName))
	fmt.Fprintf(&builder, "    <p style=\"margin: 0 0 8px;\">生成时间：%s</p>\n", handlebarsEscaper.Replace(generatedAtLabel))
	fmt.Fprintf(&builder, "    <p style=\"margin: 0 0 8px;\">摘要窗口：%s</p>\n", handlebarsEscaper.Replace(windowLabel))
	fmt.Fprintf(&builder, "    <p style=\"margin: 0 0 16px;\">共 %d 条重点事件。</p>\n", eventCount)
	builder.WriteString("    <p style=\"margin: 0 0 16px;\">\n")
	fmt.Fprintf(&builder, "      <a href=\"%s\" target=\"_blank\" rel=\"noreferrer\">打开 Today 页面查看完整摘要</a>\n", handlebarsEscaper.Replace(digestLink))
	builder.WriteString("    </p>\n\n")
	for _, event := range events {
		builder.WriteString("    <div style=\"padding: 12px 0; border-top: 1px solid #e2e8f0;\">\n")
		fmt.Fprintf(&builder, "      <h3 style=\"margin: 0 0 6px; font-size: 16px;\">%s</h3>\n", handlebarsEscaper.Replace(event.Title))
		fmt.Fprintf(&builder, "      <p style=\"margin: 0 0 6px; color: #334155;\">%s</p>\n", handlebarsEscaper.Replace(event.Summary))
		fmt.Fprintf(&builder, "      <p style=\"margin: 0 0 6px; color: #64748b; font-size: 13px;\">\n        事件条数：%d · 最近更新时间：%s\n      </p>\n", event.ItemCount, handlebarsEscaper.Replace(event.UpdatedAtLabel))
		fmt.Fprintf(&builder, "      <a href=\"%s\" target=\"_blank\" rel=\"noreferrer\">打开原文</a>\n", handlebarsEscaper.Replace(event.Link))
		builder.WriteString("    </div>\n")
	}
	builder.WriteString("  </body>\n")
	builder.WriteString("</html>\n")
	return builder.String()
}

// renderDigestText renders user-digest.text.hbs with the same Handlebars
// escaping the compiled text template applies.
func renderDigestText(recipientName, generatedAtLabel, windowLabel string, eventCount int, digestLink string, events []digestEmailEvent) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "%s，你的每日摘要已生成\n\n", handlebarsEscaper.Replace(recipientName))
	fmt.Fprintf(&builder, "生成时间：%s\n", handlebarsEscaper.Replace(generatedAtLabel))
	fmt.Fprintf(&builder, "摘要窗口：%s\n", handlebarsEscaper.Replace(windowLabel))
	fmt.Fprintf(&builder, "共 %d 条重点事件\n", eventCount)
	fmt.Fprintf(&builder, "打开 Today 页面：%s\n\n", handlebarsEscaper.Replace(digestLink))
	for _, event := range events {
		fmt.Fprintf(&builder, "- %s\n", handlebarsEscaper.Replace(event.Title))
		fmt.Fprintf(&builder, "  摘要：%s\n", handlebarsEscaper.Replace(event.Summary))
		fmt.Fprintf(&builder, "  事件条数：%d\n", event.ItemCount)
		fmt.Fprintf(&builder, "  最近更新时间：%s\n", handlebarsEscaper.Replace(event.UpdatedAtLabel))
		fmt.Fprintf(&builder, "  链接：%s\n\n", handlebarsEscaper.Replace(event.Link))
	}
	return builder.String()
}
