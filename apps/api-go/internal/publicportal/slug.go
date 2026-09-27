package publicportal

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

const topicFallback = "Top stories"

// sanitizeSlugSegment 对齐 PublicPortalService.sanitizeSlugSegment：
// NFKD、去掉 Mark、NFC、小写，非字母数字换成连字符，去掉首尾连字符。
// 结果为空时回落 "story"。
func sanitizeSlugSegment(value string) string {
	stripped := stripMarks(norm.NFKD.String(value))
	composed := strings.ToLower(norm.NFC.String(stripped))
	var b strings.Builder
	prevHyphen := false
	for _, r := range composed {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
			prevHyphen = false
			continue
		}
		if !prevHyphen && b.Len() > 0 {
			b.WriteByte('-')
			prevHyphen = true
		}
	}
	normalized := strings.Trim(b.String(), "-")
	if normalized == "" {
		return "story"
	}
	return normalized
}

func stripMarks(value string) string {
	var b strings.Builder
	for _, r := range value {
		if unicode.Is(unicode.Mark, r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func buildStorySlug(id, title string) string {
	return id + "-" + sanitizeSlugSegment(title)
}

// channelTopicLabel 是频道没有故事时的展示名：trim 后把连字符换成空格；
// 空白则回落 "Top stories"。与 topicSlug 的规范化分开。
func channelTopicLabel(topic string) string {
	trimmed := strings.TrimSpace(topic)
	if trimmed == "" {
		return topicFallback
	}
	return strings.ReplaceAll(trimmed, "-", " ")
}
