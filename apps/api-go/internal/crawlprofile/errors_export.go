package crawlprofile

import "errors"

// IsInputError reports whether err is the 400-class validation error produced by
// NormalizeConfigJSON (the crawl4ai LLM guard or the frontier scope assertion).
// The crawl discovery entries use it to keep the source's BadRequest mapping.
func IsInputError(err error) bool {
	var typed *inputError
	return errors.As(err, &typed)
}

// InputErrorMessage returns the message of an inputError.
func InputErrorMessage(err error) string {
	var typed *inputError
	if errors.As(err, &typed) {
		return typed.Message
	}
	return ""
}
