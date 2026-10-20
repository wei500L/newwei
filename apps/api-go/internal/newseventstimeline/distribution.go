package newseventstimeline

// distributionEntry is one ordered key/value pair of a category distribution.
type distributionEntry struct {
	Key   string
	Value float64
}

// orderedDistribution is a JavaScript Map while buildWeightedCategoryDistribution
// and collapseDistributionToPrefix grow it, and a JavaScript object once
// normalizeDistribution turns it into the payload stored in metadata.timeline.
//
// Both views need deterministic order: the float sums are accumulated in
// insertion order, and computeKlDivergence walks Object.keys order (array-index
// keys ascending first, then insertion order). A bare map would lose both.
type orderedDistribution struct {
	values map[string]float64
	order  []string
}

func newOrderedDistribution() *orderedDistribution {
	return &orderedDistribution{values: make(map[string]float64)}
}

// add applies Map.set(key, (get(key) ?? 0) + delta).
func (d *orderedDistribution) add(key string, delta float64) {
	if _, exists := d.values[key]; !exists {
		d.order = append(d.order, key)
	}
	d.values[key] = d.values[key] + delta
}

// set applies Map.set(key, value), keeping the first insertion position.
func (d *orderedDistribution) set(key string, value float64) {
	if _, exists := d.values[key]; !exists {
		d.order = append(d.order, key)
	}
	d.values[key] = value
}

func (d *orderedDistribution) get(key string) (float64, bool) {
	value, exists := d.values[key]
	return value, exists
}

// entries returns the pairs in insertion order.
func (d *orderedDistribution) entries() []distributionEntry {
	out := make([]distributionEntry, 0, len(d.order))
	for _, key := range d.order {
		out = append(out, distributionEntry{Key: key, Value: d.values[key]})
	}
	return out
}

func (d *orderedDistribution) len() int { return len(d.order) }

// objectKeys returns the keys in Object.keys order.
func (d *orderedDistribution) objectKeys() []string { return objectKeyOrder(d.order) }
