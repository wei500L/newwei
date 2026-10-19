package emailsettings

// AuthCodeSettings is the normalized email verification-code policy. Field order
// and names match the NestJS response.
type AuthCodeSettings struct {
	TTLSeconds      int `json:"ttlSeconds"`
	CooldownSeconds int `json:"cooldownSeconds"`
	MaxAttempts     int `json:"maxAttempts"`
}

// smtpStatus is the 14-field SMTP projection. The password is never a member.
type smtpStatus struct {
	Host                  string `json:"host"`
	Port                  int    `json:"port"`
	Secure                bool   `json:"secure"`
	User                  string `json:"user"`
	From                  string `json:"from"`
	Pool                  bool   `json:"pool"`
	MaxConnections        int    `json:"maxConnections"`
	MaxMessages           int    `json:"maxMessages"`
	RateDeltaMs           int    `json:"rateDeltaMs"`
	RateLimit             int    `json:"rateLimit"`
	ConnectionTimeoutMs   int    `json:"connectionTimeoutMs"`
	GreetingTimeoutMs     int    `json:"greetingTimeoutMs"`
	SocketTimeoutMs       int    `json:"socketTimeoutMs"`
	TLSRejectUnauthorized bool   `json:"tlsRejectUnauthorized"`
}

func (c SMTPConfig) status() smtpStatus {
	return smtpStatus{
		Host:                  c.Host,
		Port:                  c.Port,
		Secure:                c.Secure,
		User:                  c.User,
		From:                  c.From,
		Pool:                  c.Pool,
		MaxConnections:        c.MaxConnections,
		MaxMessages:           c.MaxMessages,
		RateDeltaMs:           c.RateDeltaMs,
		RateLimit:             c.RateLimit,
		ConnectionTimeoutMs:   c.ConnectionTimeoutMs,
		GreetingTimeoutMs:     c.GreetingTimeoutMs,
		SocketTimeoutMs:       c.SocketTimeoutMs,
		TLSRejectUnauthorized: c.TLSRejectUnauthorized,
	}
}

// verifyStatus is the process-local verify state. Null means "never checked".
type verifyStatus struct {
	OK        *bool   `json:"ok"`
	CheckedAt *string `json:"checkedAt"`
	Error     *string `json:"error"`
}

// statusResponse is the GET /api/system-settings/email body.
type statusResponse struct {
	SMTP     smtpStatus       `json:"smtp"`
	Verify   verifyStatus     `json:"verify"`
	AuthCode AuthCodeSettings `json:"authCode"`
}

// testResponse is the POST /api/system-settings/email/test body.
type testResponse struct {
	To        string   `json:"to"`
	MessageID string   `json:"messageId"`
	Accepted  []string `json:"accepted"`
	Rejected  []string `json:"rejected"`
}
