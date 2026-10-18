package authlogin

import (
	"context"
	"fmt"
)

// MailMessage is one plain notification message: the only shape the identity
// onboarding batch needs. It is deliberately a named struct rather than raw
// strings so a caller cannot silently swap the text and HTML parts.
type MailMessage struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// MailSender is the narrow, exported mail port. It wraps the private mailer
// that already implements the real SMTP transport (TLS/STARTTLS, greeting,
// connection and socket timeouts, SMTP_FROM fallback), so the identity
// onboarding batch reuses one transport implementation instead of copying it.
//
// It owns no pool, queue or retry loop: one connection is opened per message and
// a delivery failure is returned to the caller, exactly like EmailService.send.
type MailSender struct {
	mailer *mailer
}

// NewMailSender builds the port from the shared SMTP_* configuration.
func NewMailSender(cfg SMTPConfig) *MailSender {
	return &MailSender{mailer: newMailer(cfg)}
}

// Send delivers one multipart/alternative message.
func (s *MailSender) Send(ctx context.Context, message MailMessage) error {
	if s == nil || s.mailer == nil {
		return fmt.Errorf("authlogin: mail sender is not configured")
	}
	return s.mailer.send(ctx, message.To, message.Subject, message.Text, message.HTML)
}
