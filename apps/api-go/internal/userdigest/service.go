package userdigest

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

var (
	errMySQL = errors.New("mysql")
	errMongo = errors.New("mongo")
)

type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

func badRequest(message string) error {
	return &statusError{status: http.StatusBadRequest, message: message}
}

func notFound(message string) error {
	return &statusError{status: http.StatusNotFound, message: message}
}

// Service 聚合偏好、事件和投递日程。邮件发送与 cron 不在这里。
type Service struct {
	db     *sql.DB
	items  *mongo.Collection
	subs   personalnews.SubscriptionAPI
	search ItemSearcher
	now    func() time.Time
}

func (s *Service) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *Service) requireDB() error {
	if s == nil || s.db == nil {
		return fmt.Errorf("%w: mysql is not configured", errMySQL)
	}
	return nil
}

func (s *Service) requireSubs() error {
	if s == nil || s.subs == nil {
		return fmt.Errorf("%w: subscriptions are not configured", errMySQL)
	}
	return nil
}
