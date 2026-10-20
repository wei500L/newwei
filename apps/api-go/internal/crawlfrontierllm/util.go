package crawlfrontierllm

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strings"
)

// newCuid mints the Prisma cuid-shaped id every Go writer inserts (c + 24 hex
// characters).
func newCuid() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

var wildcardEscapeChars = regexp.MustCompile(`[|\\{}()\[\]^$+?.]`)

// wildcardToRegex is the crawl-frontier.utils wildcardToRegex: the pattern is
// anchored, `*` becomes `.*` and the match is case-insensitive.
func wildcardToRegex(pattern string) (*regexp.Regexp, error) {
	body := wildcardEscapeChars.ReplaceAllStringFunc(pattern, func(match string) string {
		return "\\" + match
	})
	body = strings.ReplaceAll(body, "*", ".*")
	return regexp.Compile("(?i)^" + body + "$")
}
