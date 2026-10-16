package crawlworkflow

import "encoding/json"

// nodeSchemasJSON 是 CRAWL_STRATEGY_NODE_SCHEMAS 的原样镜像
// （apps/api/src/modules/crawl/crawl-strategy.registry.ts）。node-schemas
// 端点直接返回它；字段与取值必须与该注册表逐项一致。
const nodeSchemasJSON = `[
  {
    "type": "seed-discovery",
    "displayName": "Seed Discovery",
    "category": "discovery",
    "description": "Resolve the first batch of URLs from sitemap, RSS, or an explicit seed URL.",
    "defaultLabel": "Seed Discovery",
    "supportsTrialRun": true,
    "defaults": {
      "mode": "sitemap",
      "seedUrl": "",
      "maxUrls": 40,
      "domain": "",
      "pattern": "",
      "feedUrl": ""
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "mode": {
          "type": "string",
          "enum": ["sitemap", "rss"],
          "default": "sitemap"
        },
        "seedUrl": { "type": "string", "default": "" },
        "domain": { "type": "string", "default": "" },
        "pattern": { "type": "string", "default": "" },
        "feedUrl": { "type": "string", "default": "" },
        "maxUrls": { "type": "number", "minimum": 1, "maximum": 200, "default": 40 }
      }
    }
  },
  {
    "type": "list-discovery",
    "displayName": "List Discovery",
    "category": "discovery",
    "description": "Discover article candidates from a list hub or archive page.",
    "defaultLabel": "List Discovery",
    "supportsTrialRun": true,
    "defaults": {
      "listUrl": "",
      "domain": "",
      "pattern": "",
      "maxUrls": 60,
      "listMaxPages": 6,
      "listPageConcurrency": 2,
      "followPagination": true,
      "crawlOptions": {}
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "listUrl": { "type": "string", "default": "" },
        "domain": { "type": "string", "default": "" },
        "pattern": { "type": "string", "default": "" },
        "maxUrls": { "type": "number", "minimum": 1, "maximum": 500, "default": 60 },
        "listMaxPages": { "type": "number", "minimum": 1, "maximum": 20, "default": 6 },
        "listPageConcurrency": {
          "type": "number",
          "minimum": 1,
          "maximum": 6,
          "default": 2
        },
        "followPagination": { "type": "boolean", "default": true },
        "crawlOptions": {
          "type": "object",
          "properties": {},
          "default": {}
        }
      }
    }
  },
  {
    "type": "deep-discovery",
    "displayName": "Deep Discovery",
    "category": "discovery",
    "description": "Run Crawl4AI deep crawl and collect article candidates.",
    "defaultLabel": "Deep Discovery",
    "supportsTrialRun": true,
    "defaults": {
      "seedUrl": "",
      "domain": "",
      "pattern": "",
      "query": "",
      "maxUrls": 60,
      "deep": {
        "maxPages": 80,
        "maxDepth": 2,
        "timeBudgetSeconds": 60,
        "pageConcurrency": 2,
        "scoreThreshold": 0.2,
        "candidatePoolSize": 120,
        "headFetchTopK": 40,
        "preferPathDate": true,
        "enableSecondaryHubs": true,
        "ignoreRobotsTxt": false
      },
      "crawlOptions": {}
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "seedUrl": { "type": "string", "default": "" },
        "domain": { "type": "string", "default": "" },
        "pattern": { "type": "string", "default": "" },
        "query": { "type": "string", "default": "" },
        "maxUrls": { "type": "number", "minimum": 1, "maximum": 500, "default": 60 },
        "deep": {
          "type": "object",
          "properties": {
            "maxPages": { "type": "number", "default": 80 },
            "maxDepth": { "type": "number", "default": 2 },
            "timeBudgetSeconds": { "type": "number", "default": 60 },
            "pageConcurrency": { "type": "number", "default": 2 },
            "scoreThreshold": { "type": "number", "default": 0.2 },
            "candidatePoolSize": { "type": "number", "default": 120 },
            "headFetchTopK": { "type": "number", "default": 40 },
            "preferPathDate": { "type": "boolean", "default": true },
            "enableSecondaryHubs": { "type": "boolean", "default": true },
            "ignoreRobotsTxt": { "type": "boolean", "default": false }
          }
        },
        "crawlOptions": {
          "type": "object",
          "properties": {},
          "default": {}
        }
      }
    }
  },
  {
    "type": "url-filter",
    "displayName": "URL Filter",
    "category": "filter",
    "description": "Apply include/exclude patterns, blocked domains, and keyword denies before scoring.",
    "defaultLabel": "URL Filter",
    "supportsTrialRun": true,
    "defaults": {
      "includePatterns": [],
      "excludePatterns": [],
      "blockedDomains": [],
      "allowedHosts": [],
      "denyKeywords": []
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "includePatterns": { "type": "array", "items": { "type": "string" }, "default": [] },
        "excludePatterns": { "type": "array", "items": { "type": "string" }, "default": [] },
        "blockedDomains": { "type": "array", "items": { "type": "string" }, "default": [] },
        "allowedHosts": { "type": "array", "items": { "type": "string" }, "default": [] },
        "denyKeywords": { "type": "array", "items": { "type": "string" }, "default": [] }
      }
    }
  },
  {
    "type": "content-filter",
    "displayName": "Content Filter",
    "category": "filter",
    "description": "Fetch content metadata and reject candidates with weak content signals.",
    "defaultLabel": "Content Filter",
    "supportsTrialRun": true,
    "defaults": {
      "query": "",
      "minRelevanceScore": 0.2,
      "requireTitle": true,
      "titleIncludes": [],
      "descriptionIncludes": [],
      "maxFetch": 20
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "default": "" },
        "minRelevanceScore": { "type": "number", "default": 0.2 },
        "requireTitle": { "type": "boolean", "default": true },
        "titleIncludes": { "type": "array", "items": { "type": "string" }, "default": [] },
        "descriptionIncludes": { "type": "array", "items": { "type": "string" }, "default": [] },
        "maxFetch": { "type": "number", "minimum": 1, "maximum": 100, "default": 20 }
      }
    }
  },
  {
    "type": "page-type-classifier",
    "displayName": "Page Type Classifier",
    "category": "scorer",
    "description": "Combine URL and signal heuristics to classify article/list/category/home.",
    "defaultLabel": "Page Type",
    "supportsTrialRun": true,
    "defaults": {},
    "configSchema": { "type": "object", "properties": {} }
  },
  {
    "type": "url-scorer",
    "displayName": "URL Scorer",
    "category": "scorer",
    "description": "Compute crawl priority based on URL structure, keywords, and page type.",
    "defaultLabel": "URL Score",
    "supportsTrialRun": true,
    "defaults": {
      "keywordBoosts": []
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "keywordBoosts": { "type": "array", "items": { "type": "string" }, "default": [] }
      }
    }
  },
  {
    "type": "freshness-scorer",
    "displayName": "Freshness Scorer",
    "category": "scorer",
    "description": "Estimate freshness from URL date signals using configurable windows.",
    "defaultLabel": "Freshness",
    "supportsTrialRun": true,
    "defaults": {
      "recentHours": 24,
      "weekHours": 168,
      "monthHours": 720
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "recentHours": { "type": "number", "default": 24 },
        "weekHours": { "type": "number", "default": 168 },
        "monthHours": { "type": "number", "default": 720 }
      }
    }
  },
  {
    "type": "branch",
    "displayName": "Branch / Condition",
    "category": "control",
    "description": "Split candidates by a condition such as page type or score threshold.",
    "defaultLabel": "Branch",
    "supportsTrialRun": true,
    "defaults": {
      "field": "pageType",
      "operator": "equals",
      "value": "article"
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "field": {
          "type": "string",
          "enum": ["pageType", "score", "freshnessScore", "relevanceScore"],
          "default": "pageType"
        },
        "operator": {
          "type": "string",
          "enum": ["equals", "gte", "lte", "contains"],
          "default": "equals"
        },
        "value": { "type": "string", "default": "article" }
      }
    }
  },
  {
    "type": "budget-control",
    "displayName": "Budget Control",
    "category": "control",
    "description": "Apply explicit crawl budget and quality threshold before persistence.",
    "defaultLabel": "Budget Control",
    "supportsTrialRun": true,
    "defaults": {
      "keepTopK": 20,
      "minScore": 0,
      "maxPages": 60,
      "maxDepth": 3
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "keepTopK": { "type": "number", "minimum": 1, "maximum": 500, "default": 20 },
        "minScore": { "type": "number", "minimum": -5, "maximum": 5, "default": 0 },
        "maxPages": { "type": "number", "minimum": 1, "maximum": 500, "default": 60 },
        "maxDepth": { "type": "number", "minimum": 1, "maximum": 8, "default": 3 }
      }
    }
  },
  {
    "type": "fallback-strategy",
    "displayName": "Fallback Strategy",
    "category": "control",
    "description": "Explicitly re-run a secondary discovery strategy when the current branch is empty.",
    "defaultLabel": "Fallback",
    "supportsTrialRun": true,
    "defaults": {
      "activateWhen": "empty",
      "mode": "list",
      "seedUrl": "",
      "domain": "",
      "pattern": "",
      "maxUrls": 20
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "activateWhen": {
          "type": "string",
          "enum": ["empty", "always"],
          "default": "empty"
        },
        "mode": {
          "type": "string",
          "enum": ["list", "deep", "rss", "sitemap"],
          "default": "list"
        },
        "seedUrl": { "type": "string", "default": "" },
        "domain": { "type": "string", "default": "" },
        "pattern": { "type": "string", "default": "" },
        "query": { "type": "string", "default": "" },
        "maxUrls": { "type": "number", "minimum": 1, "maximum": 200, "default": 20 }
      }
    }
  },
  {
    "type": "persist-result",
    "displayName": "Persist Result",
    "category": "output",
    "description": "Finalize the selected candidate set that will be applied or inspected.",
    "defaultLabel": "Persist Result",
    "supportsTrialRun": true,
    "defaults": {
      "selectTopK": 20
    },
    "configSchema": {
      "type": "object",
      "properties": {
        "selectTopK": { "type": "number", "minimum": 1, "maximum": 500, "default": 20 }
      }
    }
  }
]`

// CRAWL_STRATEGY_NODE_SCHEMAS 是 node-schemas 端点的响应体（不按 org 过滤，
// 处理函数没有 user）。
var CRAWL_STRATEGY_NODE_SCHEMAS = json.RawMessage(nodeSchemasJSON)

// nodeSchemaInfo 只保留 normalization 需要的两个字段（schema?.type、
// schema?.defaultLabel）。getCrawlStrategyNodeSchema 找不到时返回 null。
type nodeSchemaInfo struct {
	Type         string `json:"type"`
	DefaultLabel string `json:"defaultLabel"`
}

var nodeSchemasByType = func() map[string]nodeSchemaInfo {
	index := make(map[string]nodeSchemaInfo)
	var entries []nodeSchemaInfo
	if err := json.Unmarshal([]byte(nodeSchemasJSON), &entries); err != nil {
		panic("crawlworkflow: invalid node schema registry: " + err.Error())
	}
	for _, entry := range entries {
		index[entry.Type] = entry
	}
	return index
}()

func getNodeSchema(nodeType string) (nodeSchemaInfo, bool) {
	entry, ok := nodeSchemasByType[nodeType]
	return entry, ok
}
