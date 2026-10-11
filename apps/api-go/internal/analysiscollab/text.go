package analysiscollab

import "strings"

// NormalizeRequired 是 service.normalizeRequiredText。DTO 已先按未 trim 的长度拒绝。
func NormalizeRequired(value string, maxLength int, field string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", BadRequest(field + " is required")
	}
	if JSLen(trimmed) > maxLength {
		return "", BadRequest(field + " is too long")
	}
	return trimmed, nil
}

// NormalizeOptional 把缺失、null、空白收成 nil。过长返回 400。
func NormalizeOptional(value *string, maxLength int, field string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil, nil
	}
	if JSLen(trimmed) > maxLength {
		return nil, BadRequest(field + " is too long")
	}
	return &trimmed, nil
}

// NormalizeRoutePath 只允许 /search、/items、/events。先检查开头斜杠。
func NormalizeRoutePath(routePath string) (string, error) {
	trimmed := strings.TrimSpace(routePath)
	if !strings.HasPrefix(trimmed, "/") {
		return "", BadRequest("routePath must start with /")
	}
	switch trimmed {
	case "/search", "/items", "/events":
		return trimmed, nil
	default:
		return "", BadRequest("routePath is not supported")
	}
}

// ListScope 把未知 scope 收成 all。空字符串也是 all。不要改成 400。
func ListScope(scope string) string {
	switch scope {
	case "mine", "shared":
		return scope
	default:
		return "all"
	}
}
