package authlogin

import (
	"context"
	"crypto/tls"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// mailer sends the login/email-change/password-reset messages over the real SMTP
// transport configured through SMTP_*. It is implemented on the standard library
// on purpose: this batch adds no delivery platform, no queue and no connection
// pool beyond what the transport itself does.
//
// `SMTP_POOL` is accepted and ignored: the pool is a nodemailer delivery
// scheduling optimization, not a protocol difference. A single connection is
// opened per message, which is the same wire behaviour for a non-pooled
// transport.
type mailer struct {
	cfg SMTPConfig
}

func newMailer(cfg SMTPConfig) *mailer { return &mailer{cfg: cfg} }

// verificationScene selects the copy of the verification-code message.
type verificationScene string

const (
	verificationSceneBind  verificationScene = "bind"
	verificationSceneLogin verificationScene = "login"
)

// sendVerificationCode delivers the 8-digit code for the given scene.
func (m *mailer) sendVerificationCode(ctx context.Context, to string, scene verificationScene, code string, expiresMinutes int) error {
	actionLabel := "登录"
	subject := "登录验证码"
	if scene == verificationSceneBind {
		actionLabel = "邮箱绑定"
		subject = "邮箱绑定验证码"
	}
	return m.send(ctx, to, subject,
		verificationCodeText(actionLabel, code, expiresMinutes),
		verificationCodeHTML(actionLabel, code, expiresMinutes))
}

// sendPasswordReset delivers the reset link built from NEXTAUTH_URL.
func (m *mailer) sendPasswordReset(ctx context.Context, to, resetURL string) error {
	return m.send(ctx, to, "Password reset link",
		"Use this link to reset your password: "+resetURL,
		`<p>Use this link to reset your password:</p><p><a href="`+resetURL+`">`+resetURL+`</a></p>`)
}

// verificationCodeHTML renders verification-code.hbs. Handlebars escapes the
// interpolated values, but every value here is either a fixed label or a decimal
// code, so escaping cannot change the output.
func verificationCodeHTML(actionLabel, code string, expiresMinutes int) string {
	return "<html lang=\"zh-CN\">\n" +
		"  <head>\n" +
		"    <meta charset=\"utf-8\" />\n" +
		"    <title>" + actionLabel + "验证码</title>\n" +
		"  </head>\n" +
		"  <body\n" +
		"    style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a;\"\n" +
		"  >\n" +
		"    <h2 style=\"margin: 0 0 12px;\">" + actionLabel + "验证码</h2>\n" +
		"    <p style=\"margin: 0 0 12px;\">你的验证码如下：</p>\n" +
		"    <p\n" +
		"      style=\"margin: 0 0 12px; font-size: 24px; font-weight: 700; letter-spacing: 4px;\"\n" +
		"    >" + code + "</p>\n" +
		"    <p style=\"margin: 0 0 8px;\">验证码\n" +
		"      " + strconv.Itoa(expiresMinutes) + "\n" +
		"      分钟内有效，请勿泄露给他人。</p>\n" +
		"    <p\n" +
		"      style=\"margin: 0; color: #64748b; font-size: 12px;\"\n" +
		"    >如果这不是你发起的操作，请忽略本邮件。</p>\n" +
		"  </body>\n" +
		"</html>"
}

// verificationCodeText renders verification-code.text.hbs.
func verificationCodeText(actionLabel, code string, expiresMinutes int) string {
	return actionLabel + "验证码 你的验证码：" + code + "\n\n" +
		"验证码\n" +
		strconv.Itoa(expiresMinutes) + "\n" +
		"分钟内有效，请勿泄露给他人。 如果这不是你发起的操作，请忽略本邮件。"
}

// send writes one multipart/alternative message. Connection, greeting and socket
// timeouts come from the SMTP_* configuration, and TLS certificate verification
// follows SMTP_TLS_REJECT_UNAUTHORIZED.
func (m *mailer) send(ctx context.Context, to, subject, text, html string) error {
	if m == nil || m.cfg.Host == "" {
		return fmt.Errorf("authlogin: smtp transport is not configured")
	}
	if to == "" {
		return fmt.Errorf("authlogin: email target is empty")
	}
	from := m.cfg.From
	if from == "" {
		from = m.cfg.User
	}
	if from == "" {
		return fmt.Errorf("authlogin: smtp sender is not configured")
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	address := net.JoinHostPort(m.cfg.Host, strconv.Itoa(m.cfg.Port))
	connTimeout := durationMs(m.cfg.ConnectionTimeoutMs, 10*time.Second)
	greetingTimeout := durationMs(m.cfg.GreetingTimeoutMs, 10*time.Second)
	socketTimeout := durationMs(m.cfg.SocketTimeoutMs, 30*time.Second)

	conn, err := net.DialTimeout("tcp", address, connTimeout)
	if err != nil {
		return err
	}
	// The greeting and the EHLO exchange happen inside NewClient, so the deadline
	// is set before it and widened again for the payload.
	if err := conn.SetDeadline(time.Now().Add(greetingTimeout)); err != nil {
		_ = conn.Close()
		return err
	}

	tlsConfig := &tls.Config{
		ServerName:         m.cfg.Host,
		InsecureSkipVerify: !m.cfg.TLSRejectUnauthorized,
		MinVersion:         tls.VersionTLS12,
	}
	if m.cfg.Secure {
		tlsConn := tls.Client(conn, tlsConfig)
		if err := tlsConn.Handshake(); err != nil {
			_ = conn.Close()
			return err
		}
		conn = tlsConn
	}

	client, err := smtp.NewClient(conn, m.cfg.Host)
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer func() { _ = client.Close() }()

	if !m.cfg.Secure {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(tlsConfig); err != nil {
				return err
			}
		}
	}
	if m.cfg.User != "" {
		if ok, _ := client.Extension("AUTH"); ok {
			if err := client.Auth(smtp.PlainAuth("", m.cfg.User, m.cfg.Pass, m.cfg.Host)); err != nil {
				return err
			}
		}
	}
	if err := client.Mail(from); err != nil {
		return err
	}
	if err := client.Rcpt(to); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if err := conn.SetDeadline(time.Now().Add(socketTimeout)); err != nil {
		_ = writer.Close()
		return err
	}
	if _, err := writer.Write(buildMessage(from, to, subject, text, html)); err != nil {
		_ = writer.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}

// buildMessage renders a multipart/alternative message with both a text and an
// HTML part. Header values are sanitized against header injection because the
// subject is composed from fixed labels and the addresses come from the database.
func buildMessage(from, to, subject, text, html string) []byte {
	const boundary = "authlogin-boundary"
	var builder strings.Builder
	builder.WriteString("From: " + sanitizeHeader(from) + "\r\n")
	builder.WriteString("To: " + sanitizeHeader(to) + "\r\n")
	builder.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", sanitizeHeader(subject)) + "\r\n")
	builder.WriteString("MIME-Version: 1.0\r\n")
	builder.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
	builder.WriteString("\r\n")
	builder.WriteString("--" + boundary + "\r\n")
	builder.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	builder.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	builder.WriteString(text)
	builder.WriteString("\r\n--" + boundary + "\r\n")
	builder.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	builder.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	builder.WriteString(html)
	builder.WriteString("\r\n--" + boundary + "--\r\n")
	return []byte(builder.String())
}

func sanitizeHeader(value string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
}

func durationMs(value int, fallback time.Duration) time.Duration {
	if value <= 0 {
		return fallback
	}
	return time.Duration(value) * time.Millisecond
}
