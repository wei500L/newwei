package newsclassifier

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// ruleDefinition is one keyword fallback rule. English keywords use word
// boundaries so "ai" does not match "rail"; Chinese keywords are matched as
// substrings because word boundaries are meaningless for CJK text.
type ruleDefinition struct {
	legacy  string
	path    string
	english *regexp.Regexp
	chinese []string
}

// matches reports whether the lower-cased query text hits this rule. Chinese
// keywords shorter than two characters are ignored: single CJK characters are
// too common and cause false positives.
func (r ruleDefinition) matches(text string) bool {
	if r.english != nil && r.english.MatchString(text) {
		return true
	}
	for _, keyword := range r.chinese {
		if utf8.RuneCountInString(keyword) < 2 {
			continue
		}
		if strings.Contains(text, keyword) {
			return true
		}
	}
	return false
}

// ruleDefinitions is the deterministic rule fallback table, ordered by
// specificity. It mirrors the legacy categories but adds Chinese keywords so
// non-English articles can match. This table is intentionally isolated from the
// classification pipeline for future maintenance.
var ruleDefinitions = []ruleDefinition{
	{
		legacy:  "ai",
		path:    "tech/ai/model-release",
		english: regexp.MustCompile(`\b(openai|anthropic|deepmind|llm|gpt|model release|ai model)\b`),
		chinese: []string{"人工智能", "大模型", "语言模型", "模型发布", "生成式", "机器学习", "神经网络"},
	},
	{
		legacy:  "finance",
		path:    "finance/macro/monetary-policy",
		english: regexp.MustCompile(`\b(fed|fomc|inflation|cpi|gdp|bond|yield|stock|equity|nasdaq|dow)\b`),
		chinese: []string{"美联储", "央行", "加息", "降息", "利率", "通胀", "通货膨胀", "货币政策", "国债", "收益率", "股市", "股票", "债券", "纳斯达克", "道琼斯"},
	},
	{
		legacy:  "gov",
		path:    "gov/regulation/enforcement",
		english: regexp.MustCompile(`\b(regulation|regulatory|sec|doj|congress|white house|policy)\b`),
		chinese: []string{"监管", "法规", "证监会", "司法部", "国会", "白宫", "执法", "合规", "处罚"},
	},
	{
		legacy:  "intel",
		path:    "intel/defense/military-operation",
		english: regexp.MustCompile(`\b(cyber|breach|malware|ransomware|defense|military|missile|osint)\b`),
		chinese: []string{"网络攻击", "勒索软件", "恶意软件", "漏洞", "国防", "军事", "导弹", "情报", "无人机", "开源情报"},
	},
	{
		legacy:  "politics",
		path:    "politics/geopolitics/conflict",
		english: regexp.MustCompile(`\b(election|campaign|parliament|geopolitic|sanction|ceasefire|conflict)\b`),
		chinese: []string{"选举", "竞选", "议会", "地缘政治", "制裁", "停火", "冲突", "投票", "政党"},
	},
	{
		legacy:  "tech",
		path:    "tech/semiconductor/supply-chain",
		english: regexp.MustCompile(`\b(semiconductor|chip|software|hardware|cloud|startup|technology)\b`),
		chinese: []string{"半导体", "芯片", "软件", "硬件", "云计算", "创业", "科技", "供应链", "晶圆"},
	},
}
