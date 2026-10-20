package newseventstimeline

import (
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// localeCollator is the ICU root/English collator used for localeCompare. The
// timeline compares processed article ids and category paths with the default
// (no locale argument) String.prototype.localeCompare, which resolves against
// the runtime's default locale; the API process runs under the root locale, so
// the English collator is the matching rank order.
var (
	localeCollatorOnce sync.Once
	localeCollator     *collate.Collator
)

// localeCompare mirrors String.prototype.localeCompare's sign.
func localeCompare(left, right string) int {
	localeCollatorOnce.Do(func() {
		localeCollator = collate.New(language.English)
	})
	return localeCollator.CompareString(left, right)
}
