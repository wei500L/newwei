package crawlstrategyruns

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"net"

	mysqlDriver "github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// statusError mirrors a NestJS HttpException rendered by authhttp.WriteHTTPException.
type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

// inputError is a 400 from the DTO layer. Message already follows the
// class-validator + GlobalExceptionFilter joining rules.
type inputError struct{ Message string }

func (e *inputError) Error() string { return e.Message }

// unavailable reports database-unavailable errors (503, fail closed like the
// Prisma connection mapping).
func unavailable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var mysqlErr *mysqlDriver.MySQLError
	if errors.As(err, &mysqlErr) {
		switch mysqlErr.Number {
		case 1040, 1042, 1043, 1053, 1159, 1160, 1161, 2002, 2003, 2006, 2013:
			return true
		}
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}

// assertSupportedWorkflowDefinition ports assertSupportedWorkflowDefinition
// (crawl-config-policy.ts): every node's crawlOptions may not carry proxyUrl or
// proxyConfig. The message and path shape match the NestJS
// BadRequestException.
func assertSupportedWorkflowDefinition(definition crawlworkflow.WorkflowDefinition) error {
	for index, node := range definition.Nodes {
		config := objectOfValue(node.Config)
		crawlOptions, ok := objectOf(config["crawlOptions"])
		if !ok {
			continue
		}
		path := fmt.Sprintf("workflow.definition.nodes[%d].config.crawlOptions", index)
		if err := crawlprofile.AssertNoUnsupportedProxy(rawOf(crawlOptions), path); err != nil {
			return err
		}
	}
	return nil
}
