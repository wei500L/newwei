package authlogin

import (
	"context"
	"strconv"

	"github.com/wei500L/newwei/apps/api-go/internal/smtpmail"
)

// mailer sends the login/email-change/password-reset messages over the real SMTP
// transport configured through SMTP_*. The protocol work (connect, greeting,
// STARTTLS, AUTH, DATA, QUIT) lives in internal/smtpmail so the email settings
// unit shares exactly one transport implementation; this type keeps the existing
// message copy and the existing wire format (no Message-ID is added here).
//
// `SMTP_POOL` remains accepted and ignored: the pool is a nodemailer delivery
// scheduling optimization, not a protocol difference.
type mailer struct {
	cfg smtpmail.Config
}

func newMailer(cfg SMTPConfig) *mailer {
	return &mailer{cfg: smtpmail.Config{
		Host:                  cfg.Host,
		Port:                  cfg.Port,
		Secure:                cfg.Secure,
		User:                  cfg.User,
		Pass:                  cfg.Pass,
		From:                  cfg.From,
		ConnectionTimeoutMs:   cfg.ConnectionTimeoutMs,
		GreetingTimeoutMs:     cfg.GreetingTimeoutMs,
		SocketTimeoutMs:       cfg.SocketTimeoutMs,
		TLSRejectUnauthorized: cfg.TLSRejectUnauthorized,
	}}
}

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

// send writes one multipart/alternative message.
func (m *mailer) send(ctx context.Context, to, subject, text, html string) error {
	if m == nil {
		return errMailerNotConfigured
	}
	_, err := m.cfg.Send(ctx, smtpmail.Message{
		To:      to,
		Subject: subject,
		Text:    text,
		HTML:    html,
	})
	return err
}
