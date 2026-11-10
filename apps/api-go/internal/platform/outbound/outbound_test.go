package outbound

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNewClientSharesTransport(t *testing.T) {
	a := NewClient(0)
	b := NewClient(3 * time.Second)
	if a.Transport == nil || a.Transport != b.Transport {
		t.Fatalf("clients from NewClient must share one transport, got %v and %v", a.Transport, b.Transport)
	}
	if _, ok := a.Transport.(*http.Transport); !ok {
		t.Fatalf("shared transport must be *http.Transport, got %T", a.Transport)
	}
	if a.Timeout != 0 {
		t.Fatalf("zero timeout must stay zero, got %v", a.Timeout)
	}
	if b.Timeout != 3*time.Second {
		t.Fatalf("timeout must be preserved, got %v", b.Timeout)
	}
}

func TestTimeoutApplies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	if _, err := NewClient(10 * time.Millisecond).Get(server.URL); err == nil {
		t.Fatal("expected the client timeout to abort the slow request")
	}
}

func TestNoRedirect(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redirect.Close()

	resp, err := NewClient(0, NoRedirect()).Get(redirect.URL)
	if err != nil {
		t.Fatalf("NoRedirect request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("NoRedirect must surface the 3xx, got %d", resp.StatusCode)
	}

	followed, err := NewClient(0).Get(redirect.URL)
	if err != nil {
		t.Fatalf("default client request failed: %v", err)
	}
	defer followed.Body.Close()
	if followed.StatusCode != http.StatusOK {
		t.Fatalf("default client must follow redirects and reach %d, got %d", http.StatusOK, followed.StatusCode)
	}
}

// recordingTripper is a RoundTripper that records that it was used.
type recordingTripper struct {
	called bool
}

func (r *recordingTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	r.called = true
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       http.NoBody,
		Request:    req,
	}, nil
}

func TestWithTransport(t *testing.T) {
	rt := &recordingTripper{}
	client := NewClient(0, WithTransport(rt))
	if client.Transport != rt {
		t.Fatalf("WithTransport must install the supplied RoundTripper, got %T", client.Transport)
	}
	resp, err := client.Get("http://outbound.invalid/health")
	if err != nil {
		t.Fatalf("request through custom transport failed: %v", err)
	}
	defer resp.Body.Close()
	if !rt.called {
		t.Fatal("custom RoundTripper was not used")
	}
}
