package httpx

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestWriteJSONPinsResponseBytes pins the exact bytes the consolidated
// writeJSON helpers produced: JSON content type, the caller's status, the
// marshalled body, and no trailing newline.
func TestWriteJSONPinsResponseBytes(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteJSON(recorder, http.StatusCreated, map[string]any{"ok": true})
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", got)
	}
	body := recorder.Body.String()
	if body != `{"ok":true}` {
		t.Fatalf("body = %q", body)
	}
	if strings.HasSuffix(body, "\n") {
		t.Fatal("body must not end in a newline")
	}
}

// TestWriteJSONEscapesHTML proves json.Marshal's HTML escaping is preserved, so
// a payload with <, > and & stays byte-identical to the old helpers.
func TestWriteJSONEscapesHTML(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteJSON(recorder, http.StatusOK, map[string]string{"v": "<a>&"})
	if got := recorder.Body.String(); got != `{"v":"\u003ca\u003e\u0026"}` {
		t.Fatalf("body = %q", got)
	}
}

// TestWriteJSONMarshalFailure is the contract 500: http.Error writes the plain
// text body "Internal server error\n". Pinning it keeps the fallback identical
// to the per-package helpers.
func TestWriteJSONMarshalFailure(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteJSON(recorder, http.StatusOK, make(chan int))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if got := recorder.Body.String(); got != "Internal server error\n" {
		t.Fatalf("body = %q", got)
	}
}

// TestWriteRawJSONKeepsExactBytes proves WriteRawJSON does not re-encode or add a
// newline; it is used for pre-encoded bodies where bytes are contract.
func TestWriteRawJSONKeepsExactBytes(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteRawJSON(recorder, http.StatusAccepted, []byte(`{"raw":true}`))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", got)
	}
	if got := recorder.Body.String(); got != `{"raw":true}` {
		t.Fatalf("body = %q", got)
	}
}

func TestReadJSONClassifiesErrors(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"a":1}`))
		request.Header.Set("Content-Type", "application/json")
		data, err := ReadJSON(httptest.NewRecorder(), request, 1<<20)
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if string(data) != `{"a":1}` {
			t.Fatalf("data = %q", data)
		}
	})
	t.Run("charset and vendor json", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
		request.Header.Set("Content-Type", "application/vnd.api+json; charset=utf-8")
		if _, err := ReadJSON(httptest.NewRecorder(), request, 1<<20); err != nil {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("unsupported media type", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
		request.Header.Set("Content-Type", "text/plain")
		_, err := ReadJSON(httptest.NewRecorder(), request, 1<<20)
		if !errors.Is(err, ErrUnsupportedMediaType) {
			t.Fatalf("err = %v, want ErrUnsupportedMediaType", err)
		}
	})
	t.Run("invalid json", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{`))
		request.Header.Set("Content-Type", "application/json")
		_, err := ReadJSON(httptest.NewRecorder(), request, 1<<20)
		if !errors.Is(err, ErrInvalidJSON) {
			t.Fatalf("err = %v, want ErrInvalidJSON", err)
		}
	})
	t.Run("empty body", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("   "))
		request.Header.Set("Content-Type", "application/json")
		_, err := ReadJSON(httptest.NewRecorder(), request, 1<<20)
		if !errors.Is(err, ErrEmptyBody) {
			t.Fatalf("err = %v, want ErrEmptyBody", err)
		}
	})
	t.Run("nil body", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/", nil)
		request.Header.Set("Content-Type", "application/json")
		_, err := ReadJSON(httptest.NewRecorder(), request, 1<<20)
		if !errors.Is(err, ErrEmptyBody) {
			t.Fatalf("err = %v, want ErrEmptyBody", err)
		}
	})
	t.Run("body too large", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"a":"0123456789"}`))
		request.Header.Set("Content-Type", "application/json")
		_, err := ReadJSON(httptest.NewRecorder(), request, 8)
		if !errors.Is(err, ErrBodyTooLarge) {
			t.Fatalf("err = %v, want ErrBodyTooLarge", err)
		}
	})
}
