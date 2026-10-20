package crawlprofile

import (
	"encoding/json"
	"strings"
)

// This file lifts the crawl-config policy guards that already exist unexported in
// this package (crawl-profile writes) to other callers of the same crawl
// discovery chain: the news-source preview and the crawl-strategy trial/replay
// runtime. It adds no new rules.
//
// Provenance: apps/api/src/modules/crawl/crawl-config-policy.ts
// (findUnsupportedProxyIssues / assertNoUnsupportedProxy /
// findUnsupportedWorkflowDefinitionIssues) and
// apps/api/src/modules/crawl/crawl4ai-llm.guard.ts (assertNoCrawl4aiLlmOptions).

// PolicyError is the 400 the crawl-config policy guards produce. It is exported
// so the crawl discovery entries can map it to the NestJS HttpException shape
// without re-deriving the message.
type PolicyError struct{ Message string }

func (e *PolicyError) Error() string { return e.Message }

// AssertNoCrawl4aiLlmOptions rejects crawl4ai LLM extraction settings with the
// same 400 text as the NestJS guard.
func AssertNoCrawl4aiLlmOptions(raw json.RawMessage, label string) error {
	return assertNoCrawl4aiLlmOptions(raw, label)
}

// AssertNoUnsupportedProxy rejects proxyUrl/proxyConfig with the NestJS
// BadRequestException text: "Unsupported crawl config: <path>.proxyUrl: custom
// upstream proxies are not supported".
func AssertNoUnsupportedProxy(raw json.RawMessage, path string) error {
	record, ok := decodeRawObject(raw)
	if !ok {
		return nil
	}
	issues := proxyIssues(record, path)
	if len(issues) == 0 {
		return nil
	}
	return &PolicyError{Message: "Unsupported crawl config: " + strings.Join(issues, "; ")}
}

// AssertNoUnsupportedWorkflowCrawlOptions applies the proxy rule to the
// crawlOptions of one workflow node, keeping the NestJS path shape
// `workflow.definition.nodes[i].config.crawlOptions`.
func AssertNoUnsupportedWorkflowCrawlOptions(raw json.RawMessage, path string) error {
	return AssertNoUnsupportedProxy(raw, path)
}

// IsURLValid exposes the validator.js isURL port the @IsUrl DTO decorators use
// (require_tld:false, require_protocol:true) so the crawl discovery DTOs share
// the same check as the crawl-profile DTOs.
func IsURLValid(value string) bool {
	return validatorIsURL(value)
}

func proxyIssues(record map[string]json.RawMessage, path string) []string {
	issues := []string{}
	if _, ok := record["proxyUrl"]; ok {
		issues = append(issues, path+".proxyUrl: custom upstream proxies are not supported")
	}
	if _, ok := record["proxyConfig"]; ok {
		issues = append(issues, path+".proxyConfig: custom upstream proxies are not supported")
	}
	return issues
}
