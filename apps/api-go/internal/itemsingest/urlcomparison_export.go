package itemsingest

// ComparableURLVariants exposes the RawItem pre-validate URL computation to the
// pipeline recovery replay path. Replay clones a RawItem outside this package,
// and Mongoose runs the same hook on that clone, so the three columns must be
// derived from payload.url exactly as they are here.
//
// ok is false for a non-HTTP(S) or unparsable URL; the caller then stores null
// in all three columns, which is what the Mongoose default does.
func ComparableURLVariants(value string) (full, fullHash, base string, ok bool) {
	variants := buildComparableURLVariants(value)
	if variants == nil {
		return "", "", "", false
	}
	return variants.Full, variants.FullHash, variants.Base, true
}
