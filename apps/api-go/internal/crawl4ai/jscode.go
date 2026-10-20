package crawl4ai

import (
	"regexp"
	"strings"
)

// This file ports apps/api/src/modules/crawl/validators/js-code.validator.ts.
// The NestJS crawl4ai client validates every jsCode entry against this
// whitelist before the request is issued (crawl4ai.client.ts:1320-1331) and
// rejects blocked patterns with a 400. The message format and the order of the
// reported patterns are preserved so the discovery entries return the same
// error text as NestJS.

const (
	maxJSScriptLength = 2000
	maxJSScriptsCount = 5
)

type jsCodePattern struct {
	pattern *regexp.Regexp
	name    string
	reason  string
}

var jsCodeBlockedPatterns = []jsCodePattern{
	{regexp.MustCompile(`(?i)\beval\s*\(`), "eval()", "Arbitrary code execution"},
	{regexp.MustCompile(`(?i)\bnew\s+Function\s*\(`), "new Function()", "Arbitrary code execution"},
	{regexp.MustCompile(`(?i)\bFunction\s*\(`), "Function()", "Arbitrary code execution"},
	{regexp.MustCompile("(?i)\\bsetTimeout\\s*\\(\\s*[\"'`]"), "setTimeout with string", "Arbitrary code execution via string evaluation"},
	{regexp.MustCompile("(?i)\\bsetInterval\\s*\\(\\s*[\"'`]"), "setInterval with string", "Arbitrary code execution via string evaluation"},
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
	{regexp.MustCompile("(?i)\\bdocument\\s*\\.\\s*createElement\\s*\\(\\s*[\"'`]script[\"'`]\\s*\\)"), "createElement('script')", "Script injection"},
	{regexp.MustCompile(`(?i)\\u00[0-9a-f]{2}`), "Unicode escape sequence", "Potential obfuscation attempt"},
	{regexp.MustCompile(`(?i)\\x[0-9a-f]{2}`), "Hex escape sequence", "Potential obfuscation attempt"},
	{regexp.MustCompile(`(?i)String\s*\.\s*fromCharCode`), "String.fromCharCode", "Potential obfuscation attempt"},
	{regexp.MustCompile(`(?i)String\s*\.\s*fromCodePoint`), "String.fromCodePoint", "Potential obfuscation attempt"},
	{regexp.MustCompile(`(?i)\batob\s*\(`), "atob()", "Base64 decoding - potential obfuscation"},
	{regexp.MustCompile(`(?i)\bbtoa\s*\(`), "btoa()", "Base64 encoding - potential data exfiltration"},
	{regexp.MustCompile("(?i)\\[\\s*[\"'`]eval[\"'`]\\s*\\]"), "['eval'] bracket access", "Obfuscated eval access"},
	{regexp.MustCompile("(?i)\\[\\s*[\"'`]Function[\"'`]\\s*\\]"), "['Function'] bracket access", "Obfuscated Function access"},
	{regexp.MustCompile("(?i)\\[\\s*[\"'`]constructor[\"'`]\\s*\\]"), "['constructor'] bracket access", "Obfuscated constructor access"},
}

var (
	jsSingleLineComment = regexp.MustCompile(`(?m)//.*$`)
	jsMultiLineComment  = regexp.MustCompile(`(?s)/\*.*?\*/`)
)

// validateJSCodeArray mirrors validateJsCodeArray: it returns the blocked
// pattern list in the NestJS order, already prefixed with the script index.
func validateJSCodeArray(scripts []string) []string {
	if len(scripts) == 0 {
		return nil
	}
	blocked := []string{}
	if len(scripts) > maxJSScriptsCount {
		blocked = append(blocked, "Too many scripts: "+itoa(len(scripts))+" exceeds maximum of "+itoa(maxJSScriptsCount))
	}
	for index, script := range scripts {
		for _, entry := range validateJSCode(script) {
			blocked = append(blocked, "Script["+itoa(index)+"]: "+entry)
		}
	}
	if len(blocked) == 0 {
		return nil
	}
	return blocked
}

func validateJSCode(code string) []string {
	trimmed := strings.TrimSpace(code)
	if trimmed == "" {
		return nil
	}
	blocked := []string{}
	if len(trimmed) > maxJSScriptLength {
		blocked = append(blocked, "Script exceeds maximum length of "+itoa(maxJSScriptLength)+" characters")
	}
	withoutComments := jsMultiLineComment.ReplaceAllString(jsSingleLineComment.ReplaceAllString(trimmed, ""), "")
	for _, entry := range jsCodeBlockedPatterns {
		if entry.pattern.MatchString(withoutComments) {
			blocked = append(blocked, entry.name+": "+entry.reason)
		}
	}
	if len(blocked) == 0 {
		return nil
	}
	return blocked
}
