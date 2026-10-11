package contentcatalog

func defaultTaxonomy() []taxNode {
	return []taxNode{
		{
			Path: "tech/ai/model-release", DisplayName: "AI Model Release", LegacyCategory: "ai",
			Description: "Announcements, launches, benchmarks, pricing, or capability updates for AI/LLM models.",
			Keywords:    []string{"model", "release", "llm", "gpt", "benchmark", "inference"},
			Synonyms:    []string{"model launch", "foundation model", "large language model"},
		},
		{
			Path: "tech/ai/policy-governance", DisplayName: "AI Policy", LegacyCategory: "gov",
			Description: "Regulatory or governance developments specifically focused on AI deployment and safety.",
			Keywords:    []string{"ai act", "regulation", "safety", "governance", "compliance"},
			Synonyms:    []string{"ai regulation", "ai policy"},
		},
		{
			Path: "tech/cyber/security-incident", DisplayName: "Cyber Incident", LegacyCategory: "intel",
			Description: "Cybersecurity breaches, ransomware, malware campaigns, data leaks, and incident response.",
			Keywords:    []string{"breach", "ransomware", "malware", "vulnerability", "exploit"},
			Synonyms:    []string{"cyber attack", "security incident", "data breach"},
		},
		{
			Path: "tech/semiconductor/supply-chain", DisplayName: "Semiconductor Supply Chain", LegacyCategory: "tech",
			Description: "Chip manufacturing capacity, export controls, fab expansion, and upstream/downstream impacts.",
			Keywords:    []string{"semiconductor", "chip", "foundry", "fab", "export control"},
			Synonyms:    []string{"chip supply chain", "semiconductor policy"},
		},
		{
			Path: "finance/markets/equities", DisplayName: "Equity Markets", LegacyCategory: "finance",
			Description: "Stock market moves, earnings reactions, analyst actions, and equity volatility events.",
			Keywords:    []string{"stock", "equity", "earnings", "nasdaq", "dow", "s&p"},
			Synonyms:    []string{"equity market", "stock market"},
		},
		{
			Path: "finance/macro/monetary-policy", DisplayName: "Monetary Policy", LegacyCategory: "finance",
			Description: "Central bank decisions, rate guidance, inflation indicators, and macro policy interpretation.",
			Keywords:    []string{"fed", "fomc", "rate", "inflation", "cpi", "yield"},
			Synonyms:    []string{"interest rate policy", "central bank policy"},
		},
		{
			Path: "finance/crypto/market-move", DisplayName: "Crypto Market Move", LegacyCategory: "finance",
			Description: "Major cryptocurrency price shocks, market structure events, and policy-driven crypto repricing.",
			Keywords:    []string{"bitcoin", "ethereum", "crypto", "token", "exchange"},
			Synonyms:    []string{"digital asset", "crypto market"},
		},
		{
			Path: "gov/regulation/enforcement", DisplayName: "Regulatory Enforcement", LegacyCategory: "gov",
			Description: "Government enforcement actions, investigations, penalties, and compliance mandates.",
			Keywords:    []string{"sec", "doj", "investigation", "penalty", "enforcement"},
			Synonyms:    []string{"regulatory action", "compliance enforcement"},
		},
		{
			Path: "politics/geopolitics/conflict", DisplayName: "Geopolitical Conflict", LegacyCategory: "politics",
			Description: "Armed conflict developments, sanctions escalation, ceasefire talks, and regional tensions.",
			Keywords:    []string{"conflict", "sanction", "ceasefire", "war", "airstrike"},
			Synonyms:    []string{"geopolitical tension", "regional conflict"},
		},
		{
			Path: "politics/election/domestic", DisplayName: "Election Dynamics", LegacyCategory: "politics",
			Description: "Election campaigns, polling shifts, coalition changes, and institutional political dynamics.",
			Keywords:    []string{"election", "campaign", "parliament", "coalition", "vote"},
			Synonyms:    []string{"electoral politics", "political campaign"},
		},
		{
			Path: "intel/defense/military-operation", DisplayName: "Military Operation", LegacyCategory: "intel",
			Description: "Defense operations, force movement, weapon system deployment, and military intelligence signals.",
			Keywords:    []string{"defense", "military", "drone", "missile", "operation"},
			Synonyms:    []string{"military activity", "defense intelligence"},
		},
		{
			Path: "intel/osint/analysis", DisplayName: "OSINT Signal", LegacyCategory: "intel",
			Description: "Open-source intelligence findings and analytical assessments with security implications.",
			Keywords:    []string{"osint", "intelligence", "analysis", "satellite", "tracking"},
			Synonyms:    []string{"open-source intelligence", "intel assessment"},
		},
	}
}
