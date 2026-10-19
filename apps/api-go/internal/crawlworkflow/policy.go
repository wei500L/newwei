package crawlworkflow

import (
	"encoding/json"
	"strconv"
	"strings"
)

// This file ports crawl-config-policy.ts's assertSupportedWorkflowDefinition and
// assertNoUnsupportedProxy for the workflow definition and crawlOptions objects
// the trial-run path validates.
//
// findByDisallowedProxyIssues mirrors findUnsupportedWorkflowDefinitionIssues:
// only `nodes[i].config.crawlOptions.proxyUrl` / `proxyConfig` are rejected, and
// the message keeps the source's `path: message` list format joined by "; ".

// AssertSupportedWorkflowDefinition rejects custom upstream proxies in any node's
// crawlOptions. path defaults to "draftDefinition" in the source; trial-run
// passes "workflow.definition".
func AssertSupportedWorkflowDefinition(definition WorkflowDefinition, path string) error {
	issues := []string{}
	for index, node := range definition.Nodes {
		options, ok := decodeRawObject(node.Config)
		if !ok {
			continue
		}
		crawlOptions, ok := decodeRawObject(options["crawlOptions"])
		if !ok {
			continue
		}
		basePath := path + ".nodes[" + strconv.Itoa(index) + "].config.crawlOptions"
		for _, key := range []string{"proxyUrl", "proxyConfig"} {
			if _, exists := crawlOptions[key]; exists {
				issues = append(issues, basePath+"."+key+": custom upstream proxies are not supported")
			}
		}
	}
	if len(issues) == 0 {
		return nil
	}
	return &inputError{Message: "Unsupported crawl config: " + strings.Join(issues, "; ")}
}

// AssertNoUnsupportedProxy rejects a top-level crawlOptions object carrying the
// two proxy keys. The news-source preview merges the template and source options
// and validates the result with this function, exactly like the source.
func AssertNoUnsupportedProxy(raw json.RawMessage, path string) error {
	options, ok := decodeRawObject(raw)
	if !ok {
		return nil
	}
	issues := []string{}
	for _, key := range []string{"proxyUrl", "proxyConfig"} {
		if _, exists := options[key]; exists {
			issues = append(issues, path+"."+key+": custom upstream proxies are not supported")
		}
	}
	if len(issues) == 0 {
		return nil
	}
	return &inputError{Message: "Unsupported crawl config: " + strings.Join(issues, "; ")}
}
