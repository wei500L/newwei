package smtpmail

import (
	"bufio"
	"context"
	"net"
	"net/textproto"
	"strings"
	"sync"
	"testing"
)

// smtpFixture is a minimal in-process SMTP server (net/textproto only) that
// proves the real verify/send wire behaviour without an external dependency.
type smtpFixture struct {
	listener net.Listener
	reject   string
	mu       sync.Mutex
	messages []string
	mailFrom []string
	auths    int
	done     chan struct{}
}

func newSMTPFixture(t *testing.T) *smtpFixture {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fixture := &smtpFixture{listener: listener, done: make(chan struct{})}
	go fixture.serve()
	t.Cleanup(func() {
		close(fixture.done)
		_ = listener.Close()
	})
	return fixture
}

func (f *smtpFixture) port() int {
	return f.listener.Addr().(*net.TCPAddr).Port
}

func (f *smtpFixture) setReject(address string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reject = address
}

func (f *smtpFixture) lastMessage() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.messages) == 0 {
		return ""
	}
	return f.messages[len(f.messages)-1]
}

// lastMailFrom returns the envelope sender of the most recent MAIL FROM line.
func (f *smtpFixture) lastMailFrom() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.mailFrom) == 0 {
		return ""
	}
	return f.mailFrom[len(f.mailFrom)-1]
}

func (f *smtpFixture) serve() {
	for {
		conn, err := f.listener.Accept()
		if err != nil {
			return
		}
		go f.handle(conn)
	}
}

func (f *smtpFixture) handle(conn net.Conn) {
	defer conn.Close()
	reader := textproto.NewReader(bufio.NewReader(conn))
	write := func(line string) { _, _ = conn.Write([]byte(line + "\r\n")) }
	write("220 fixture ESMTP")
	for {
		line, err := reader.ReadLine()
		if err != nil {
			return
		}
		command := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(command, "EHLO"), strings.HasPrefix(command, "HELO"):
			_, _ = conn.Write([]byte("250-fixture\r\n250-AUTH PLAIN\r\n250 OK\r\n"))
		case strings.HasPrefix(command, "AUTH"):
			f.mu.Lock()
			f.auths++
			f.mu.Unlock()
			write("235 2.7.0 Authentication successful")
		case strings.HasPrefix(command, "MAIL FROM"):
			f.mu.Lock()
			f.mailFrom = append(f.mailFrom, line)
			f.mu.Unlock()
			write("250 2.1.0 OK")
		case strings.HasPrefix(command, "RCPT TO"):
			address := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "RCPT TO:"), ">"))
			address = strings.TrimPrefix(address, "<")
			f.mu.Lock()
			reject := f.reject
			f.mu.Unlock()
			if reject != "" && strings.EqualFold(address, reject) {
				write("550 5.1.1 No such user")
				continue
			}
			write("250 2.1.5 OK")
		case strings.HasPrefix(command, "DATA"):
			write("354 End data with <CR><LF>.<CR><LF>")
			data, err := reader.ReadDotBytes()
			if err != nil {
				return
			}
			f.mu.Lock()
			f.messages = append(f.messages, string(data))
			f.mu.Unlock()
			write("250 2.0.0 OK")
		case strings.HasPrefix(command, "QUIT"):
			write("221 2.0.0 Bye")
			return
		default:
			write("500 5.5.1 Command not recognized")
		}
	}
}

func fixtureConfig(fixture *smtpFixture) Config {
	return Config{
		Host:                  "127.0.0.1",
		Port:                  fixture.port(),
		User:                  "mailer@example.com",
		Pass:                  "secret",
		From:                  "mailer@example.com",
		ConnectionTimeoutMs:   2000,
		GreetingTimeoutMs:     2000,
		SocketTimeoutMs:       2000,
		TLSRejectUnauthorized: true,
	}
}

func TestVerifyPerformsRealHandshake(t *testing.T) {
	fixture := newSMTPFixture(t)
	if err := fixtureConfig(fixture).Verify(context.Background()); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	auths := fixture.auths
	fixture.mu.Unlock()
	if auths != 1 {
		t.Fatalf("AUTH count = %d, want 1", auths)
	}
}

func TestSendReturnsMessageIDAndAccepted(t *testing.T) {
	fixture := newSMTPFixture(t)
	result, err := fixtureConfig(fixture).Send(context.Background(), Message{
		To:        "mailer@example.com",
		Subject:   "Test email",
		Text:      "plain body",
		HTML:      "<p>html body</p>",
		MessageID: NewMessageID("mailer@example.com"),
		TraceID:   "trace-9",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Accepted) != 1 || result.Accepted[0] != "mailer@example.com" || len(result.Rejected) != 0 {
		t.Fatalf("result = %+v", result)
	}
	message := fixture.lastMessage()
	for _, want := range []string{"Message-ID: " + result.MessageID, "x-trace-id: trace-9", "plain body", "<p>html body</p>"} {
		if !strings.Contains(message, want) {
			t.Fatalf("message does not contain %q:\n%s", want, message)
		}
	}
}

func TestSendAllRecipientsRejected(t *testing.T) {
	fixture := newSMTPFixture(t)
	fixture.setReject("blocked@example.com")
	result, err := fixtureConfig(fixture).Send(context.Background(), Message{
		To:      "blocked@example.com",
		Subject: "Test email",
		Text:    "body",
		HTML:    "<p>body</p>",
	})
	if err == nil {
		t.Fatal("expected an error when every recipient is rejected")
	}
	if len(result.Accepted) != 0 || len(result.Rejected) != 1 {
		t.Fatalf("result = %+v", result)
	}
}

func TestUnconfiguredTransportFails(t *testing.T) {
	err := (Config{}).Verify(context.Background())
	if err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("err = %v", err)
	}
}

func TestNewMessageIDShape(t *testing.T) {
	id := NewMessageID("someone@example.org")
	if !strings.HasPrefix(id, "<") || !strings.HasSuffix(id, "@example.org>") {
		t.Fatalf("message id = %q", id)
	}
	if strings.Count(id, "@") != 1 {
		t.Fatalf("message id = %q", id)
	}
}

// TestEnvelopeAddressExtractsDisplayName pins the nodemailer equivalent of
// parsing a configured sender: the display name stays in the header, the
// envelope carries only the mailbox.
func TestEnvelopeAddressExtractsDisplayName(t *testing.T) {
	cases := []struct{ input, want string }{
		{input: "wei500l@163.com", want: "wei500l@163.com"},
		{input: "  wei500l@163.com  ", want: "wei500l@163.com"},
		{input: "Wei <wei500l@163.com>", want: "wei500l@163.com"},
		{input: "Wei < wei500l@163.com >", want: "wei500l@163.com"},
		{input: "\"Wei, L\" <wei500l@163.com>", want: "wei500l@163.com"},
		{input: "<wei500l@163.com>", want: "wei500l@163.com"},
		{input: "Wei <>", want: "Wei <>"},
	}
	for _, testCase := range cases {
		t.Run(testCase.input, func(t *testing.T) {
			if got := envelopeAddress(testCase.input); got != testCase.want {
				t.Fatalf("envelopeAddress(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

// TestSendUsesTheMailboxAsEnvelopeSender covers the SMTP_FROM form the shipped
// .env sample uses ("Wei <wei500l@163.com>"): MAIL FROM must carry the bare
// address (a nested angle bracket is a syntax error for a real server) while the
// From: header keeps the display name.
func TestSendUsesTheMailboxAsEnvelopeSender(t *testing.T) {
	fixture := newSMTPFixture(t)
	config := fixtureConfig(fixture)
	config.From = "Mailer <mailer@example.com>"

	if _, err := config.Send(context.Background(), Message{
		To:      "admin@example.com",
		Subject: "Test email",
		Text:    "body",
		HTML:    "<p>body</p>",
	}); err != nil {
		t.Fatal(err)
	}
	if got := fixture.lastMailFrom(); got != "MAIL FROM:<mailer@example.com>" {
		t.Fatalf("envelope sender = %q", got)
	}
	if message := fixture.lastMessage(); !strings.Contains(message, "From: Mailer <mailer@example.com>") {
		t.Fatalf("message does not keep the display name:\n%s", message)
	}
}

// TestNewMessageIDIgnoresTheDisplayName pins the domain extraction for a
// display-name sender, which previously produced a "</…@163.com>>" Message-ID.
func TestNewMessageIDIgnoresTheDisplayName(t *testing.T) {
	id := NewMessageID("Wei <wei500l@163.com>")
	if !strings.HasSuffix(id, "@163.com>") || strings.HasSuffix(id, ">>") {
		t.Fatalf("message id = %q", id)
	}
	if strings.Count(id, "<") != 1 || strings.Count(id, ">") != 1 {
		t.Fatalf("message id = %q", id)
	}
}
