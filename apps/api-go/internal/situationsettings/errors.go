package situationsettings

import (
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// httpError is a status-coded failure mapped onto the NestJS
// GlobalExceptionFilter response shape.
type httpError struct {
	status  int
	message string
}

func (e *httpError) Error() string { return e.message }

// badRequest builds the flat 400 both NestJS services raise for values that pass
// the DTO but fail a service-level rule, and the ValidationPipe message array.
func badRequest(message string) error {
	return &httpError{status: http.StatusBadRequest, message: message}
}

// writeServiceError maps a service error onto the NestJS error contract.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch {
		case coded.status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case coded.status >= http.StatusInternalServerError:
			authhttp.WriteInternalFailure(w, r)
		default:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
		}
		return
	}
	if errors.Is(err, errNoDatabase) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	log.Printf("situationsettings: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
