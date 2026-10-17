package kgimpact

import (
	"fmt"
	"math"
	"strconv"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

var (
	localeOnce     sync.Once
	localeCollator *collate.Collator
	localeMu       sync.Mutex
)

// localeCompare aligns JavaScript's default localeCompare English collation
// order. Candidate tie-breasing and member ordering use it so the JSON shape
// stays identical to Nest.
func localeCompare(a, b string) int {
	localeOnce.Do(func() {
		localeCollator = collate.New(language.English)
	})
	localeMu.Lock()
	defer localeMu.Unlock()
	return localeCollator.CompareString(a, b)
}

// jsRound matches JavaScript Math.round: ties go toward +Infinity.
func jsRound(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	return math.Floor(value + 0.5)
}

func itoa(value int) string {
	return strconv.Itoa(value)
}

// toFixed renders a base-10 fixed representation like Number.prototype.toFixed.
func toFixed(value float64, digits int) string {
	return strconv.FormatFloat(value, 'f', digits, 64)
}

// jsString mirrors `${value}` for values read from Mongo. A missing field is
// "undefined", matching the Nest template literal.
func jsString(value any) string {
	if value == nil {
		return "undefined"
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
