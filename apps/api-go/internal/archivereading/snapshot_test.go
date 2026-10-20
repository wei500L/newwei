package archivereading

import "testing"

func TestExportRoundRobinOrderAndCap(t *testing.T) {
	groups := ExportGroups{}
	groups[VerticalEastSea] = snapshotItems("east", 150)
	groups[VerticalSouthSea] = snapshotItems("south", 30)
	groups[VerticalWestFront] = []DigestItem{}
	groups[VerticalForeignAffairs] = snapshotItems("foreign", 90)
	groups[VerticalDomesticAffairs] = snapshotItems("domestic", 120)

	items := groups.RoundRobinItems(5000)
	if len(items) != 390 {
		t.Fatalf("row count = %d, want 390", len(items))
	}
	// Round 0: 100 east, 30 south, 90 foreign, 100 domestic. Round 1 picks the
	// remaining 50 east then 20 domestic. Empty groups are skipped without
	// restarting a completed group.
	if items[0].ProcessedArticleID != "east-0" || items[99].ProcessedArticleID != "east-99" {
		t.Fatalf("east round 0 = %s..%s", items[0].ProcessedArticleID, items[99].ProcessedArticleID)
	}
	if items[100].ProcessedArticleID != "south-0" {
		t.Fatalf("south did not start at 100: %s", items[100].ProcessedArticleID)
	}
	if items[130].ProcessedArticleID != "foreign-0" {
		t.Fatalf("foreign did not start after south: %s", items[130].ProcessedArticleID)
	}
	if items[220].ProcessedArticleID != "domestic-0" {
		t.Fatalf("domestic did not start after foreign: %s", items[220].ProcessedArticleID)
	}
	if items[320].ProcessedArticleID != "east-100" {
		t.Fatalf("second round did not resume east: %s", items[320].ProcessedArticleID)
	}
}

func TestExportRoundRobinDeduplicatesAndCaps(t *testing.T) {
	groups := ExportGroups{}
	groups[VerticalEastSea] = snapshotItems("a", 4000)
	groups[VerticalSouthSea] = snapshotItems("b", 4000)
	items := groups.RoundRobinItems(5000)
	if len(items) != 5000 {
		t.Fatalf("cap = %d, want 5000", len(items))
	}
	seen := map[string]struct{}{}
	for _, item := range items {
		if _, ok := seen[item.ProcessedArticleID]; ok {
			t.Fatalf("duplicate id %s", item.ProcessedArticleID)
		}
		seen[item.ProcessedArticleID] = struct{}{}
	}
}

func snapshotItems(prefix string, count int) []DigestItem {
	items := make([]DigestItem, 0, count)
	for index := 0; index < count; index++ {
		items = append(items, DigestItem{ProcessedArticleID: prefix + "-" + itoa(index)})
	}
	return items
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 8)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
