package newsnowhottest

import "github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"

// comparableURLVariants is the comparable triple of one URL. It mirrors
// buildComparableUrlVariants in packages/mongo/src/url-comparison.ts through the
// read port newsnowclusteringops already owns, so the hottest matcher and the
// public /resolve endpoint can never normalize a URL differently.
func comparableURLVariants(rawURL string) (newsnowclusteringops.ComparableURLVariants, bool) {
	return newsnowclusteringops.BuildComparableURLVariants(rawURL)
}

// resolveFallbackPattern is the level-5 payload.url regex of one comparable base.
func resolveFallbackPattern(base string) string {
	return newsnowclusteringops.BuildResolveFallbackPattern(base)
}
