package analysis

import "strings"

// CalculateMainCharacter mirrors calculateMainCharacter.
func CalculateMainCharacter(allNews []NewsItem) MainCharacterResults {
	if len(allNews) == 0 {
		return MainCharacterResults{Characters: []MainCharacterEntry{}, TopCharacter: nil}
	}
	counts := map[string]int{}
	order := make([]string, 0)
	for _, item := range allNews {
		text := strings.ToLower(item.Title)
		for _, pattern := range personPatterns {
			matches := pattern.pattern.FindAllStringIndex(text, -1)
			if len(matches) == 0 {
				continue
			}
			if counts[pattern.name] == 0 {
				order = append(order, pattern.name)
			}
			counts[pattern.name] += len(matches)
		}
	}
	type entry struct {
		name  string
		count int
	}
	entries := make([]entry, 0, len(order))
	for _, name := range order {
		entries = append(entries, entry{name: name, count: counts[name]})
	}
	// Object.entries order is insertion order and Array#sort is stable, so an
	// equal count keeps the first person found.
	sortStableEntries(entries, func(left, right entry) bool { return left.count > right.count })
	if len(entries) > 10 {
		entries = entries[:10]
	}
	characters := make([]MainCharacterEntry, 0, len(entries))
	for index, item := range entries {
		characters = append(characters, MainCharacterEntry{Name: item.name, Count: item.count, Rank: index + 1})
	}
	var top *MainCharacterEntry
	if len(characters) > 0 {
		value := characters[0]
		top = &value
	}
	return MainCharacterResults{Characters: characters, TopCharacter: top}
}

// GetMainCharacterSummary mirrors getMainCharacterSummary.
func GetMainCharacterSummary(results MainCharacterResults) MainCharacterSummary {
	if results.TopCharacter == nil {
		return MainCharacterSummary{Name: "", Count: 0, Status: "NO DATA"}
	}
	return MainCharacterSummary{
		Name:   results.TopCharacter.Name,
		Count:  results.TopCharacter.Count,
		Status: results.TopCharacter.Name + " (" + itoa(results.TopCharacter.Count) + " mentions)",
	}
}

// sortStableEntries is a small insertion sort so the package does not expose
// its private entry type to sort.Slice's reflection.
func sortStableEntries[T any](items []T, less func(a, b T) bool) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && less(items[j], items[j-1]); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}
