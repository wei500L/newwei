package analysis

import "regexp"

// correlationTopic mirrors CorrelationTopic.
type correlationTopic struct {
	id       string
	patterns []*regexp.Regexp
	category string
}

// narrativePattern mirrors NarrativePattern.
type narrativePattern struct {
	id       string
	keywords []string
	category string
	severity string
}

// sourceTypes mirrors SOURCE_TYPES.
type sourceTypes struct {
	fringe      []string
	alternative []string
	mainstream  []string
}

// personPattern mirrors PersonPattern.
type personPattern struct {
	pattern *regexp.Regexp
	name    string
}

// correlationTopics mirrors CORRELATION_TOPICS in declaration order.
var correlationTopics = []correlationTopic{
	{"tariffs", patterns(`tariff`, `trade war`, `import tax`, `customs duty`), "Economy"},
	{"fed-rates", patterns(`federal reserve`, `interest rate`, `rate cut`, `rate hike`, `powell`, `fomc`), "Economy"},
	{"inflation", patterns(`inflation`, `cpi`, `consumer price`, `cost of living`), "Economy"},
	{"ai-regulation", patterns(`ai regulation`, `artificial intelligence.*law`, `ai safety`, `ai governance`), "Tech"},
	{"china-tensions", patterns(`china.*taiwan`, `south china sea`, `us.*china`, `beijing.*washington`), "Geopolitics"},
	{"russia-ukraine", patterns(`ukraine`, `zelensky`, `putin.*war`, `crimea`, `donbas`), "Conflict"},
	{"israel-gaza", patterns(`gaza`, `hamas`, `netanyahu`, `israel.*attack`, `hostage`), "Conflict"},
	{"iran", patterns(`iran.*nuclear`, `tehran`, `ayatollah`, `iranian.*strike`), "Geopolitics"},
	{"crypto", patterns(`bitcoin`, `crypto.*regulation`, `ethereum`, `sec.*crypto`), "Finance"},
	{"housing", patterns(`housing market`, `mortgage rate`, `home price`, `real estate.*crash`), "Economy"},
	{"layoffs", patterns(`layoff`, `job cut`, `workforce reduction`, `downsizing`), "Business"},
	{"bank-crisis", patterns(`bank.*fail`, `banking crisis`, `fdic`, `bank run`), "Finance"},
	{"election", patterns(`election`, `polling`, `campaign`, `ballot`, `voter`), "Politics"},
	{"immigration", patterns(`immigration`, `border.*crisis`, `migrant`, `deportation`, `asylum`), "Politics"},
	{"climate", patterns(`climate change`, `wildfire`, `hurricane`, `extreme weather`, `flood`), "Environment"},
	{"pandemic", patterns(`pandemic`, `outbreak`, `virus.*spread`, `who.*emergency`, `bird flu`), "Health"},
	{"nuclear", patterns(`nuclear.*threat`, `nuclear weapon`, `atomic`, `icbm`), "Security"},
	{"supply-chain", patterns(`supply chain`, `shipping.*delay`, `port.*congestion`, `logistics.*crisis`), "Economy"},
	{"big-tech", patterns(`antitrust.*tech`, `google.*monopoly`, `meta.*lawsuit`, `apple.*doj`), "Tech"},
	{"deepfake", patterns(`deepfake`, `ai.*misinformation`, `synthetic media`), "Tech"},
}

// narrativePatterns mirrors NARRATIVE_PATTERNS in declaration order.
var narrativePatterns = []narrativePattern{
	{"deep-state", []string{"deep state", "shadow government", "permanent state"}, "Political", "watch"},
	{"cbdc-control", []string{"cbdc control", "digital currency surveillance", "social credit"}, "Finance", "watch"},
	{"wef-agenda", []string{"great reset", "wef agenda", "world economic forum plot"}, "Political", "watch"},
	{"bio-weapon", []string{"lab leak", "bioweapon", "gain of function"}, "Health", "emerging"},
	{"election-fraud", []string{"election fraud", "rigged election", "stolen election", "mail ballot fraud"}, "Political", "watch"},
	{"ai-doom", []string{"ai doom", "ai extinction", "superintelligence risk", "agi danger"}, "Tech", "emerging"},
	{"ai-consciousness", []string{"ai sentient", "ai conscious", "ai feelings", "ai alive"}, "Tech", "emerging"},
	{"robot-replacement", []string{"robots replacing", "automation unemployment", "job automation"}, "Economy", "spreading"},
	{"china-invasion", []string{"china taiwan invasion", "china war", "south china sea conflict"}, "Geopolitical", "watch"},
	{"nato-expansion", []string{"nato provocation", "nato aggression", "nato encirclement"}, "Geopolitical", "watch"},
	{"dollar-collapse", []string{"dollar collapse", "dedollarization", "brics currency", "petrodollar death"}, "Finance", "spreading"},
	{"vaccine-injury", []string{"vaccine injury", "vaccine side effect", "vaccine death", "turbo cancer"}, "Health", "watch"},
	{"next-pandemic", []string{"next pandemic", "disease x", "bird flu pandemic"}, "Health", "emerging"},
	{"depopulation", []string{"depopulation agenda", "fertility crisis", "population control"}, "Society", "disinfo"},
	{"food-crisis", []string{"food shortage", "engineered famine", "food supply attack"}, "Economy", "emerging"},
	{"energy-war", []string{"energy crisis manufactured", "green agenda", "energy shortage"}, "Economy", "spreading"},
}

// sourceTypesList mirrors SOURCE_TYPES.
var sourceTypesList = sourceTypes{
	fringe:      []string{"zerohedge", "infowars", "naturalnews", "gateway", "breitbart", "epoch", "revolver", "dailycaller"},
	alternative: []string{"substack", "rumble", "bitchute", "telegram", "gab", "gettr", "truth social"},
	mainstream:  []string{"reuters", "ap news", "bbc", "cnn", "nytimes", "wsj", "wapo", "guardian", "abc", "nbc", "cbs", "fox"},
}

// personPatterns mirrors PERSON_PATTERNS. JS regexes compile with the `i` flag
// and count every non-overlapping match, which Go's FindAllString reproduces.
var personPatterns = []personPattern{
	{regexp.MustCompile(`(?i)\btrump\b`), "Trump"},
	{regexp.MustCompile(`(?i)\bbiden\b`), "Biden"},
	{regexp.MustCompile(`(?i)\belon\b|\bmusk\b`), "Elon Musk"},
	{regexp.MustCompile(`(?i)\bputin\b`), "Putin"},
	{regexp.MustCompile(`(?i)\bzelensky\b`), "Zelensky"},
	{regexp.MustCompile(`(?i)\bxi\s*jinping\b|\bxi\b`), "Xi Jinping"},
	{regexp.MustCompile(`(?i)\bnetanyahu\b`), "Netanyahu"},
	{regexp.MustCompile(`(?i)\bsam\s*altman\b`), "Sam Altman"},
	{regexp.MustCompile(`(?i)\bmark\s*zuckerberg\b|\bzuckerberg\b`), "Zuckerberg"},
	{regexp.MustCompile(`(?i)\bjeff\s*bezos\b|\bbezos\b`), "Bezos"},
	{regexp.MustCompile(`(?i)\btim\s*cook\b`), "Tim Cook"},
	{regexp.MustCompile(`(?i)\bsatya\s*nadella\b|\bnadella\b`), "Satya Nadella"},
	{regexp.MustCompile(`(?i)\bsundar\s*pichai\b|\bpichai\b`), "Sundar Pichai"},
	{regexp.MustCompile(`(?i)\bwarren\s*buffett\b|\bbuffett\b`), "Warren Buffett"},
	{regexp.MustCompile(`(?i)\bjanet\s*yellen\b|\byellen\b`), "Janet Yellen"},
	{regexp.MustCompile(`(?i)\bjerome\s*powell\b|\bpowell\b`), "Jerome Powell"},
	{regexp.MustCompile(`(?i)\bkamala\s*harris\b|\bharris\b`), "Kamala Harris"},
	{regexp.MustCompile(`(?i)\bnancy\s*pelosi\b|\bpelosi\b`), "Nancy Pelosi"},
	{regexp.MustCompile(`(?i)\bjensen\s*huang\b|\bhuang\b`), "Jensen Huang"},
	{regexp.MustCompile(`(?i)\bdario\s*amodei\b|\bamodei\b`), "Dario Amodei"},
}

// CorrelationTopicIDs returns the configured ids in declaration order.
func CorrelationTopicIDs() []string {
	out := make([]string, 0, len(correlationTopics))
	for _, topic := range correlationTopics {
		out = append(out, topic.id)
	}
	return out
}

// NarrativePatternIDs returns the configured ids in declaration order.
func NarrativePatternIDs() []string {
	out := make([]string, 0, len(narrativePatterns))
	for _, pattern := range narrativePatterns {
		out = append(out, pattern.id)
	}
	return out
}

func patterns(values ...string) []*regexp.Regexp {
	out := make([]*regexp.Regexp, 0, len(values))
	for _, value := range values {
		out = append(out, regexp.MustCompile(`(?i)`+value))
	}
	return out
}
