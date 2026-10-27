// Package smtpmail is the shared SMTP transport for api-go. It implements the
// subset of nodemailer's behaviour the migrated endpoints need: a real verify
// handshake (connect, EHLO, optional STARTTLS, AUTH, QUIT) and a real
// multipart/alternative delivery that reports the provider Message-ID plus the
// accepted and rejected recipients.
//
// The package is intentionally a thin protocol layer. It owns no connection
// pool: every verify and every send opens its own connection, which is the same
// wire behaviour as a non-pooled nodemailer transport and keeps rollback free of
// close/shutdown ordering.
package smtpmail

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// Config is the SMTP transport configuration (the Env.smtpConfig equivalent).
type Config struct {
	Host                  string
	Port                  int
	Secure                bool
	User                  string
	Pass                  string
	From                  string
	ConnectionTimeoutMs   int
	GreetingTimeoutMs     int
	SocketTimeoutMs       int
	TLSRejectUnauthorized bool
}

// Message is one multipart/alternative message. MessageID is optional: when it
// is empty no Message-ID header is written, which keeps the existing auth/login
// wire format unchanged. TraceID, when set, is written as x-trace-id.
type Message struct {
	From      string
	To        string
	Subject   string
	Text      string
	HTML      string
	MessageID string
	TraceID   string
}

// Result is the delivery outcome. Accepted and Rejected are the RCPT verdicts.
type Result struct {
	MessageID string
	Accepted  []string
	Rejected  []string
}

// envelopeAddress extracts the RFC 5321 mailbox from a configured address that
// may carry a display name ("Wei <wei@example.com>"): the value inside the last
// angle-bracket pair, otherwise the trimmed input. It mirrors what nodemailer's
// address parser hands to MAIL FROM/RCPT TO, so a display-name SMTP_FROM keeps
// producing a valid envelope sender instead of `MAIL FROM:<Wei <addr>>`.
func envelopeAddress(value string) string {
	trimmed := strings.TrimSpace(value)
	if open := strings.LastIndexByte(trimmed, '<'); open >= 0 {
		if close := strings.IndexByte(trimmed[open:], '>'); close > 1 {
			inner := strings.TrimSpace(trimmed[open+1 : open+close])
			if inner != "" {
				return inner
			}
		}
	}
	return trimmed
}

// NewMessageID builds a Message-ID header value of the shape nodemailer
// produces: <random@domain-of-sender>. The domain falls back to the host name
// when the sender address has no domain; a display-name sender is reduced to its
// mailbox first so the domain never picks up the closing angle bracket.
func NewMessageID(from string) string {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "<" + strconv.FormatInt(time.Now().UnixNano(), 36) + "@modular-api>"
	}
	domain := "modular-api"
	address := envelopeAddress(from)
	if at := strings.LastIndex(address, "@"); at >= 0 && at+1 < len(address) {
		if trimmed := strings.TrimSpace(address[at+1:]); trimmed != "" {
			domain = trimmed
		}
	}
	return "<" + hex.EncodeToString(buf[:]) + "." + strconv.FormatInt(time.Now().UnixNano(), 36) + "@" + domain + ">"
}

// Verify performs the nodemailer transporter.verify equivalent: connect (TLS
// immediately when Secure), read the greeting and EHLO, upgrade with STARTTLS
// when advertised, authenticate when a user is configured, then QUIT.
func (c Config) Verify(ctx context.Context) error {
	client, conn, closeAll, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer closeAll()

	if c.User != "" {
		if ok, _ := client.Extension("AUTH"); ok {
			if err := conn.SetDeadline(time.Now().Add(c.socketTimeout())); err != nil {
				return err
			}
			if err := client.Auth(smtp.PlainAuth("", c.User, c.Pass, c.Host)); err != nil {
				return err
			}
		}
	}
	return client.Quit()
}

// Send delivers one message and reports the provider Message-ID and the RCPT
// verdicts. A recipient the server rejects is reported in Result.Rejected; when
// every recipient is rejected the delivery fails like nodemailer's
// "all recipients were rejected" error and no DATA phase is entered.
func (c Config) Send(ctx context.Context, msg Message) (Result, error) {
	result := Result{MessageID: msg.MessageID, Accepted: []string{}, Rejected: []string{}}
	client, conn, closeAll, err := c.dial(ctx)
	if err != nil {
		return result, err
	}
	defer closeAll()

	// headerFrom keeps the raw configured value for the From: header (a display
	// name is legal there), while envelopeFrom is the bare mailbox MAIL FROM
	// carries. nodemailer parses the same value the same way, so
	// `SMTP_FROM="Wei <addr>"` — the form infra/docker/.env.sample ships — must
	// reach the SMTP envelope as `addr` and not as `Wei <addr>`.
	headerFrom := strings.TrimSpace(msg.From)
	if headerFrom == "" {
		headerFrom = strings.TrimSpace(c.From)
	}
	if headerFrom == "" {
		headerFrom = strings.TrimSpace(c.User)
	}
	if headerFrom == "" {
		return result, fmt.Errorf("smtpmail: sender is not configured")
	}
	envelopeFrom := envelopeAddress(headerFrom)
	if envelopeFrom == "" {
		return result, fmt.Errorf("smtpmail: sender is not configured")
	}
	to := envelopeAddress(msg.To)
	if to == "" {
		return result, fmt.Errorf("smtpmail: recipient is empty")
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}

	if c.User != "" {
		if ok, _ := client.Extension("AUTH"); ok {
			if err := conn.SetDeadline(time.Now().Add(c.socketTimeout())); err != nil {
				return result, err
			}
			if err := client.Auth(smtp.PlainAuth("", c.User, c.Pass, c.Host)); err != nil {
				return result, err
			}
		}
	}
	if err := client.Mail(envelopeFrom); err != nil {
		return result, err
	}
	if err := client.Rcpt(to); err != nil {
		result.Rejected = append(result.Rejected, to)
		_ = client.Quit()
		return result, fmt.Errorf("smtpmail: all recipients were rejected")
	}
	result.Accepted = append(result.Accepted, to)

	writer, err := client.Data()
	if err != nil {
		return result, err
	}
	if err := conn.SetDeadline(time.Now().Add(c.socketTimeout())); err != nil {
		_ = writer.Close()
		return result, err
	}
	if _, err := writer.Write(buildMessage(headerFrom, to, msg)); err != nil {
		_ = writer.Close()
		return result, err
	}
	if err := writer.Close(); err != nil {
		return result, err
	}
	return result, client.Quit()
}

// dial opens the connection and completes the greeting/EHLO/STARTTLS sequence.
// closeAll closes the protocol client and the underlying socket, which is safe
// to call after a successful Quit as well.
func (c Config) dial(ctx context.Context) (*smtp.Client, net.Conn, func(), error) {
	if strings.TrimSpace(c.Host) == "" || c.Port <= 0 {
		return nil, nil, func() {}, fmt.Errorf("smtpmail: smtp transport is not configured")
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, func() {}, err
	}
	address := net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	dialer := &net.Dialer{Timeout: c.connectionTimeout()}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, nil, func() {}, err
	}
	// The greeting and EHLO exchange happens inside NewClient, so the greeting
	// deadline covers both.
	if err := conn.SetDeadline(time.Now().Add(c.greetingTimeout())); err != nil {
		_ = conn.Close()
		return nil, nil, func() {}, err
	}

	tlsConfig := &tls.Config{
		ServerName:         c.Host,
		InsecureSkipVerify: !c.TLSRejectUnauthorized,
		MinVersion:         tls.VersionTLS12,
	}
	if c.Secure {
		tlsConn := tls.Client(conn, tlsConfig)
		if err := tlsConn.Handshake(); err != nil {
			_ = conn.Close()
			return nil, nil, func() {}, err
		}
		conn = tlsConn
	}

	client, err := smtp.NewClient(conn, c.Host)
	if err != nil {
		_ = conn.Close()
		return nil, nil, func() {}, err
	}
	closeAll := func() {
		_ = client.Close()
		_ = conn.Close()
	}
	if !c.Secure {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := conn.SetDeadline(time.Now().Add(c.socketTimeout())); err != nil {
				closeAll()
				return nil, nil, func() {}, err
			}
			if err := client.StartTLS(tlsConfig); err != nil {
				closeAll()
				return nil, nil, func() {}, err
			}
		}
	}
	if err := conn.SetDeadline(time.Now().Add(c.socketTimeout())); err != nil {
		closeAll()
		return nil, nil, func() {}, err
	}
	return client, conn, closeAll, nil
}

func (c Config) connectionTimeout() time.Duration {
	return durationMs(c.ConnectionTimeoutMs, 10*time.Second)
}
func (c Config) greetingTimeout() time.Duration {
	return durationMs(c.GreetingTimeoutMs, 10*time.Second)
}
func (c Config) socketTimeout() time.Duration { return durationMs(c.SocketTimeoutMs, 30*time.Second) }

func durationMs(value int, fallback time.Duration) time.Duration {
	if value <= 0 {
		return fallback
	}
	return time.Duration(value) * time.Millisecond
}

// buildMessage renders a multipart/alternative message. Header values are
// sanitized against header injection because the subject and recipients may
// originate from a request.
func buildMessage(from, to string, msg Message) []byte {
	const boundary = "api-go-smtp-boundary"
	var builder strings.Builder
	builder.WriteString("From: " + sanitizeHeader(from) + "\r\n")
	builder.WriteString("To: " + sanitizeHeader(to) + "\r\n")
	subject := msg.Subject
	if subject == "" {
		subject = "Test email"
	}
	builder.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", sanitizeHeader(subject)) + "\r\n")
	builder.WriteString("MIME-Version: 1.0\r\n")
	if msg.MessageID != "" {
		builder.WriteString("Message-ID: " + sanitizeHeader(msg.MessageID) + "\r\n")
	}
	if msg.TraceID != "" {
		builder.WriteString("x-trace-id: " + sanitizeHeader(msg.TraceID) + "\r\n")
	}
	builder.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
	builder.WriteString("\r\n")
	builder.WriteString("--" + boundary + "\r\n")
	builder.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	builder.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	builder.WriteString(msg.Text)
	builder.WriteString("\r\n--" + boundary + "\r\n")
	builder.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	builder.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	builder.WriteString(msg.HTML)
	builder.WriteString("\r\n--" + boundary + "--\r\n")
	return []byte(builder.String())
}

func sanitizeHeader(value string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
}
