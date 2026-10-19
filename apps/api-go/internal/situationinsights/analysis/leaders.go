package analysis

import (
	"regexp"
	"sort"
	"strings"
)

// worldLeaderConfig mirrors WorldLeaderConfig.
type worldLeaderConfig struct {
	id       string
	name     string
	title    string
	country  string
	flag     string
	keywords []string
	since    string
	party    string
	focus    []string
}

// worldLeaders mirrors WORLD_LEADERS in declaration order.
var worldLeaders = []worldLeaderConfig{
	{"trump", "Donald Trump", "President", "United States", "🇺🇸", []string{"trump", "potus", "white house"}, "Jan 2025", "Republican", []string{"tariffs", "immigration", "deregulation"}},
	{"vance", "JD Vance", "Vice President", "United States", "🇺🇸", []string{"jd vance", "vice president vance"}, "Jan 2025", "Republican", nil},
	{"xi", "Xi Jinping", "President", "China", "🇨🇳", []string{"xi jinping", "xi", "chinese president"}, "Mar 2013", "CCP", []string{"taiwan", "belt and road", "tech dominance"}},
	{"putin", "Vladimir Putin", "President", "Russia", "🇷🇺", []string{"putin", "kremlin", "russian president"}, "May 2012", "United Russia", []string{"ukraine war", "nato expansion", "energy"}},
	{"starmer", "Keir Starmer", "Prime Minister", "United Kingdom", "🇬🇧", []string{"starmer", "uk pm", "british prime minister"}, "Jul 2024", "Labour", nil},
	{"macron", "Emmanuel Macron", "President", "France", "🇫🇷", []string{"macron", "french president", "elysee"}, "May 2017", "Renaissance", nil},
	{"scholz", "Olaf Scholz", "Chancellor", "Germany", "🇩🇪", []string{"scholz", "german chancellor", "berlin"}, "Dec 2021", "SPD", nil},
	{"meloni", "Giorgia Meloni", "Prime Minister", "Italy", "🇮🇹", []string{"meloni", "italian pm", "italy prime minister"}, "Oct 2022", "Brothers of Italy", nil},
	{"netanyahu", "Benjamin Netanyahu", "Prime Minister", "Israel", "🇮🇱", []string{"netanyahu", "bibi", "israeli pm"}, "Dec 2022", "Likud", []string{"gaza", "iran", "judicial reform"}},
	{"mbs", "Mohammed bin Salman", "Crown Prince", "Saudi Arabia", "🇸🇦", []string{"mbs", "saudi crown prince", "bin salman"}, "Jun 2017", "Royal Family", []string{"vision 2030", "oil", "regional influence"}},
	{"khamenei", "Ali Khamenei", "Supreme Leader", "Iran", "🇮🇷", []string{"khamenei", "supreme leader", "ayatollah"}, "Jun 1989", "Islamic Republic", []string{"nuclear program", "proxies", "sanctions"}},
	{"modi", "Narendra Modi", "Prime Minister", "India", "🇮🇳", []string{"modi", "indian pm", "india prime minister"}, "May 2014", "BJP", []string{"economy", "china border", "technology"}},
	{"kim", "Kim Jong Un", "Supreme Leader", "North Korea", "🇰🇵", []string{"kim jong un", "north korea", "pyongyang"}, "Dec 2011", "Workers Party", []string{"nuclear", "missiles", "russia alliance"}},
	{"ishiba", "Shigeru Ishiba", "Prime Minister", "Japan", "🇯🇵", []string{"ishiba", "japanese pm", "japan prime minister"}, "Oct 2024", "LDP", []string{"defense", "china", "us alliance"}},
	{"lai", "Lai Ching-te", "President", "Taiwan", "🇹🇼", []string{"lai ching-te", "taiwan president", "taipei"}, "May 2024", "DPP", []string{"china relations", "defense", "semiconductors"}},
	{"zelensky", "Volodymyr Zelensky", "President", "Ukraine", "🇺🇦", []string{"zelensky", "ukraine president", "kyiv"}, "May 2019", "Servant of the People", []string{"war", "western aid", "nato membership"}},
	{"milei", "Javier Milei", "President", "Argentina", "🇦🇷", []string{"milei", "argentina president", "buenos aires"}, "Dec 2023", "La Libertad Avanza", []string{"dollarization", "spending cuts", "deregulation"}},
	{"lula", "Luiz Inácio Lula da Silva", "President", "Brazil", "🇧🇷", []string{"lula", "brazil president", "brasilia"}, "Jan 2023", "PT", []string{"amazon", "social programs", "brics"}},
	{"carney", "Mark Carney", "Prime Minister", "Canada", "🇨🇦", []string{"carney", "canadian pm", "canada prime minister", "ottawa"}, "Mar 2025", "Liberal", []string{"tariffs", "us relations", "economy"}},
}

var simpleKeywordPattern = regexp.MustCompile(`^[a-z0-9]+$`)

// BuildWorldLeaders mirrors buildWorldLeaders.
func BuildWorldLeaders(news []NewsItem) []WorldLeader {
	items := make([]NewsItem, 0, len(news))
	for _, item := range news {
		if item.Title != "" {
			items = append(items, item)
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].Timestamp > items[j].Timestamp })

	results := make([]WorldLeader, 0, len(worldLeaders))
	for _, leader := range worldLeaders {
		matched := make([]NewsItem, 0)
		for _, item := range items {
			if matchesLeader(item.Title, leader.keywords) {
				matched = append(matched, item)
			}
		}
		headlines := make([]HeadlineRef, 0, 2)
		for _, item := range matched {
			if len(headlines) >= 2 {
				break
			}
			headlines = append(headlines, HeadlineRef{
				Title: item.Title, Link: item.Link, Source: item.Source, Timestamp: item.Timestamp,
			})
		}
		results = append(results, WorldLeader{
			ID: leader.id, Name: leader.name, Title: leader.title, Country: leader.country,
			Flag: leader.flag, Since: leader.since, Party: leader.party, Focus: leader.focus,
			MatchCount: len(matched), Headlines: headlines,
		})
	}
	sort.SliceStable(results, func(i, j int) bool { return results[i].MatchCount > results[j].MatchCount })
	return results
}

func matchesLeader(title string, keywords []string) bool {
	lower := strings.ToLower(title)
	for _, keyword := range keywords {
		normalized := strings.ToLower(strings.TrimSpace(keyword))
		if normalized == "" {
			continue
		}
		if len(normalized) <= 3 && simpleKeywordPattern.MatchString(normalized) {
			pattern := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(normalized) + `\b`)
			if pattern.MatchString(title) {
				return true
			}
			continue
		}
		if strings.Contains(lower, normalized) {
			return true
		}
	}
	return false
}
