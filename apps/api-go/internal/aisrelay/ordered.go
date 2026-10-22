package aisrelay

// The Node relay keeps every aggregate in a Map and relies on two Map guarantees:
// iteration follows insertion order, and re-setting an existing key keeps the
// original position. Several outputs depend on that order - the stable sorts in
// the snapshot fall back to it, and eviction walks the oldest entries first - so
// Go must not iterate a plain map here. The two containers below restore the JS
// semantics explicitly.
//
// Deletion is tombstone-based: the ordered key slice keeps its positions and a
// dead key is skipped during iteration. Compaction rewrites the slice only after
// the hole count passes a threshold, which keeps deletion O(1) amortised.

// orderedMap is a string-keyed map with JS Map insertion-order semantics.
type orderedMap[V any] struct {
	order []string
	items map[string]V
	dead  int
}

// orderedMapCompactionFloor is the smallest key-slice length at which holes are
// reclaimed. Below it the slice is short enough that scanning holes is cheaper
// than rebuilding, which keeps the common small-snapshot case allocation-free.
const orderedMapCompactionFloor = 64

func newOrderedMap[V any]() *orderedMap[V] {
	return &orderedMap[V]{items: make(map[string]V)}
}

// Len reports the number of live entries.
func (m *orderedMap[V]) Len() int {
	return len(m.items)
}

// Get returns the value for key and whether it is present.
func (m *orderedMap[V]) Get(key string) (V, bool) {
	value, ok := m.items[key]
	return value, ok
}

// Set stores value under key. Like Map.prototype.set, re-setting an existing key
// updates the value without moving it to the end of the iteration order.
func (m *orderedMap[V]) Set(key string, value V) {
	if _, ok := m.items[key]; !ok {
		m.order = append(m.order, key)
	}
	m.items[key] = value
}

// Delete removes key, reporting whether it was present.
func (m *orderedMap[V]) Delete(key string) bool {
	if _, ok := m.items[key]; !ok {
		return false
	}
	delete(m.items, key)
	m.dead++
	// Reclaim holes once they dominate the slice so memory stays proportional to
	// the live entry count during sustained churn.
	if m.dead > orderedMapCompactionFloor && m.dead*2 >= len(m.order) {
		m.compact()
	}
	return true
}

// compact drops tombstones while preserving insertion order.
func (m *orderedMap[V]) compact() {
	kept := make([]string, 0, len(m.items))
	for _, key := range m.order {
		if _, ok := m.items[key]; ok {
			kept = append(kept, key)
		}
	}
	m.order = kept
	m.dead = 0
}

// Range visits live entries in insertion order. The callback must not insert new
// keys; deleting the current or a later key is allowed, matching Map iteration
// while the Node cleanup passes delete entries.
func (m *orderedMap[V]) Range(visit func(key string, value V) bool) {
	for index := 0; index < len(m.order); index++ {
		key := m.order[index]
		value, ok := m.items[key]
		if !ok {
			continue
		}
		if !visit(key, value) {
			return
		}
	}
}

// Keys returns the live keys in insertion order.
func (m *orderedMap[V]) Keys() []string {
	keys := make([]string, 0, len(m.items))
	for _, key := range m.order {
		if _, ok := m.items[key]; ok {
			keys = append(keys, key)
		}
	}
	return keys
}

// orderedSet is a string set with JS Set semantics: iteration follows insertion
// order and re-adding an existing member keeps its original position.
type orderedSet struct {
	order   []string
	members map[string]struct{}
	dead    int
}

func newOrderedSet() *orderedSet {
	return &orderedSet{members: make(map[string]struct{})}
}

// Len reports the number of members.
func (s *orderedSet) Len() int {
	return len(s.members)
}

// Has reports membership.
func (s *orderedSet) Has(value string) bool {
	_, ok := s.members[value]
	return ok
}

// Add inserts value, keeping the original position for an existing member.
func (s *orderedSet) Add(value string) {
	if _, ok := s.members[value]; ok {
		return
	}
	s.members[value] = struct{}{}
	s.order = append(s.order, value)
}

// Delete removes value, reporting whether it was present.
func (s *orderedSet) Delete(value string) bool {
	if _, ok := s.members[value]; !ok {
		return false
	}
	delete(s.members, value)
	s.dead++
	if s.dead > orderedMapCompactionFloor && s.dead*2 >= len(s.order) {
		s.compact()
	}
	return true
}

func (s *orderedSet) compact() {
	kept := make([]string, 0, len(s.members))
	for _, value := range s.order {
		if _, ok := s.members[value]; ok {
			kept = append(kept, value)
		}
	}
	s.order = kept
	s.dead = 0
}

// Values returns the live members in insertion order. The Node density cleanup
// iterates a copied member array, which this method reproduces for callers that
// mutate the set while walking it.
func (s *orderedSet) Values() []string {
	values := make([]string, 0, len(s.members))
	for _, value := range s.order {
		if _, ok := s.members[value]; ok {
			values = append(values, value)
		}
	}
	return values
}
