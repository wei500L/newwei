package crawloptions

import (
	"fmt"
	"regexp"
	"strings"
)

// This file ports modules/crawl/validators/js-code.validator.ts: the same
// blocked-pattern allowlist and the same rejection message, so a jsCode value
// accepted by NestJS is accepted here and vice versa.

const (
	// MaxScriptLength is MAX_SCRIPT_LENGTH.
	MaxScriptLength = 2000
	// MaxScriptsCount is MAX_SCRIPTS_COUNT.
	MaxScriptsCount = 5
)

type blockedPattern struct {
	pattern *regexp.Regexp
	name    string
	reason  string
}

var blockedPatterns = []blockedPattern{
	{regexp.MustCompile(`(?i)\beval\s*\(`), "eval()", "Arbitrary code execution"},
	{regexp.MustCompile(`(?i)\bnew\s+Function\s*\(`), "new Function()", "Arbitrary code execution"},
	{regexp.MustCompile(`(?i)\bFunction\s*\(`), "Function()", "Arbitrary code execution"},
	{regexp.MustCompile(`(?i)\bsetTimeout\s*\(\s*["'` + "`" + `]`), "setTimeout with string", "Arbitrary code execution via string evaluation"},
	{regexp.MustCompile(`(?i)\bsetInterval\s*\(\s*["'` + "`" + `]`), "setInterval with string", "Arbitrary code execution via string evaluation"},
	{regexp.MustCompile(`(?i)\bfetch\s*\(`), "fetch()", "Network request - data exfiltration risk"},
	{regexp.MustCompile(`(?i)\bnew\s+XMLHttpRequest\s*\(`), "new XMLHttpRequest()", "Network request - data exfiltration risk"},
	{regexp.MustCompile(`(?i)\bXMLHttpRequest\s*\(`), "XMLHttpRequest()", "Network request - data exfiltration risk"},
	{regexp.MustCompile(`(?i)\bnew\s+WebSocket\s*\(`), "new WebSocket()", "Network request - data exfiltration risk"},
	{regexp.MustCompile(`(?i)\bnavigator\s*\.\s*sendBeacon\s*\(`), "navigator.sendBeacon()", "Network request - data exfiltration risk"},
	{regexp.MustCompile(`(?i)\bimport\s*\(`), "dynamic import()", "Module loading - arbitrary code execution"},
	{regexp.MustCompile(`(?i)\bimport\s+`), "import statement", "Module loading - arbitrary code execution"},
	{regexp.MustCompile(`(?i)\brequire\s*\(`), "require()", "Module loading - arbitrary code execution"},
	{regexp.MustCompile(`(?i)__proto__`), "__proto__", "Prototype pollution attack vector"},
	{regexp.MustCompile(`(?i)\bconstructor\s*\.\s*prototype`), "constructor.prototype", "Prototype pollution attack vector"},
	{regexp.MustCompile(`(?i)Object\s*\.\s*setPrototypeOf`), "Object.setPrototypeOf", "Prototype pollution attack vector"},
	{regexp.MustCompile(`(?i)Object\s*\.\s*defineProperty`), "Object.defineProperty", "Prototype pollution attack vector"},
	{regexp.MustCompile(`(?i)Object\s*\.\s*defineProperties`), "Object.defineProperties", "Prototype pollution attack vector"},
	{regexp.MustCompile(`(?i)Reflect\s*\.\s*setPrototypeOf`), "Reflect.setPrototypeOf", "Prototype pollution attack vector"},
	{regexp.MustCompile(`(?i)\bprocess\s*\.`), "process.*", "Node.js process access"},
	{regexp.MustCompile(`(?i)\bglobal\s*\.`), "global.*", "Global object access"},
	{regexp.MustCompile(`(?i)\bglobalThis\s*\.`), "globalThis.*", "Global object access"},
	{regexp.MustCompile(`(?i)\bdocument\s*\.\s*write\s*\(`), "document.write()", "DOM injection - XSS risk"},
	{regexp.MustCompile(`(?i)\bdocument\s*\.\s*writeln\s*\(`), "document.writeln()", "DOM injection - XSS risk"},
	{regexp.MustCompile(`(?i)\.innerHTML\s*=`), "innerHTML assignment", "DOM injection - XSS risk"},
	{regexp.MustCompile(`(?i)\.outerHTML\s*=`), "outerHTML assignment", "DOM injection - XSS risk"},
	{regexp.MustCompile(`(?i)\.insertAdjacentHTML\s*\(`), "insertAdjacentHTML()", "DOM injection - XSS risk"},
	{regexp.MustCompile(`(?i)\blocalStorage\s*\.`), "localStorage", "Storage access - data exfiltration risk"},
	{regexp.MustCompile(`(?i)\bsessionStorage\s*\.`), "sessionStorage", "Storage access - data exfiltration risk"},
	{regexp.MustCompile(`(?i)\bindexedDB\s*\.`), "indexedDB", "Storage access - data exfiltration risk"},
	{regexp.MustCompile(`(?i)\bdocument\s*\.\s*cookie`), "document.cookie", "Cookie access - data exfiltration risk"},
	{regexp.MustCompile(`(?i)\bdocument\s*\.\s*createElement\s*\(\s*["'` + "`" + `]script["'` + "`" + `]\s*\)`), "createElement('script')", "Script injection"},
	{regexp.MustCompile(`(?i)\\u00[0-9a-f]{2}`), "Unicode escape sequence", "Potential obfuscation attempt"},
	{regexp.MustCompile(`(?i)\\x[0-9a-f]{2}`), "Hex escape sequence", "Potential obfuscation attempt"},
	{regexp.MustCompile(`(?i)String\s*\.\s*fromCharCode`), "String.fromCharCode", "Potential obfuscation attempt"},
	{regexp.MustCompile(`(?i)String\s*\.\s*fromCodePoint`), "String.fromCodePoint", "Potential obfuscation attempt"},
	{regexp.MustCompile(`(?i)\batob\s*\(`), "atob()", "Base64 decoding - potential obfuscation"},
	{regexp.MustCompile(`(?i)\bbtoa\s*\(`), "btoa()", "Base64 encoding - potential data exfiltration"},
	{regexp.MustCompile(`(?i)\[\s*["'` + "`" + `]eval["'` + "`" + `]\s*\]`), "['eval'] bracket access", "Obfuscated eval access"},
	{regexp.MustCompile(`(?i)\[\s*["'` + "`" + `]Function["'` + "`" + `]\s*\]`), "['Function'] bracket access", "Obfuscated Function access"},
	{regexp.MustCompile(`(?i)\[\s*["'` + "`" + `]constructor["'` + "`" + `]\s*\]`), "['constructor'] bracket access", "Obfuscated constructor access"},
}

var (
	singleLineComment = regexp.MustCompile(`(?m)//.*$`)
	multiLineComment  = regexp.MustCompile(`(?s)/\*.*?\*/`)
)

// ValidateJSCode returns the blocked-pattern descriptions of one script. An
// empty script is valid, exactly like validateJsCode.
func ValidateJSCode(code string) []string {
	trimmed := strings.TrimSpace(code)
	if trimmed == "" {
		return nil
	}
	blocked := make([]string, 0)
	if len(trimmed) > MaxScriptLength {
		blocked = append(blocked,
			fmt.Sprintf("Script exceeds maximum length of %d characters", MaxScriptLength))
	}
	withoutComments := multiLineComment.ReplaceAllString(singleLineComment.ReplaceAllString(trimmed, ""), "")
	for _, entry := range blockedPatterns {
		if entry.pattern.MatchString(withoutComments) {
			blocked = append(blocked, entry.name+": "+entry.reason)
		}
	}
	return blocked
}

// ValidateJSCodeArray validates the array form (each: true), prefixing each hit
// with Script[index] like validateJsCodeArray.
func ValidateJSCodeArray(scripts []string) []string {
	blocked := make([]string, 0)
	if len(scripts) > MaxScriptsCount {
		blocked = append(blocked,
			fmt.Sprintf("Too many scripts: %d exceeds maximum of %d", len(scripts), MaxScriptsCount))
	}
	for index, script := range scripts {
		for _, hit := range ValidateJSCode(script) {
			blocked = append(blocked, fmt.Sprintf("Script[%d]: %s", index, hit))
		}
	}
	return blocked
}

// JSCodeConstraintMessage is IsAllowedJsCodeConstraint.defaultMessage.
func JSCodeConstraintMessage(property string, blocked []string) string {
	if len(blocked) == 0 {
		return property + " contains invalid JavaScript code"
	}
	listed := blocked
	if len(listed) > 5 {
		listed = listed[:5]
	}
	suffix := ""
	if len(blocked) > 5 {
		suffix = fmt.Sprintf(" (and %d more)", len(blocked)-5)
	}
	return fmt.Sprintf("%s contains blocked JavaScript patterns: %s%s. "+
		"Only safe DOM operations (scroll, click, querySelector) are allowed. "+
		"Max %d scripts, %d chars each.",
		property, strings.Join(listed, "; "), suffix, MaxScriptsCount, MaxScriptLength)
}
