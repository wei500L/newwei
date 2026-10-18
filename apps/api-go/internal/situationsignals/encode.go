package situationsignals

import "encoding/json"

// encodedResponse is a response body that renders itself as JSON.
//
// A named interface keeps the responder free of untyped parameters: every
// response type in this package implements it explicitly, so writeJSON never
// needs a variadic or empty interface.
type encodedResponse interface {
	// encodeJSON renders the response body.
	encodeJSON() ([]byte, error)
}

// encodeJSON renders the catalog response.
func (r catalogResponse) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// encodeJSON renders the feedback response.
func (r feedbackResponse) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// encodeJSON renders the refresh-run response.
func (r refreshRunResponse) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// encodeJSON renders the Telegram feed response.
func (r telegramFeedResponse) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// encodeJSON renders the OREF alerts response.
func (r orefAlertsResponse) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// encodeJSON renders the OREF history response.
func (r orefHistoryResponse) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// encodeJSON renders the live HLS proxy configuration response.
func (r liveHLSProxyConfig) encodeJSON() ([]byte, error) { return json.Marshal(r) }
