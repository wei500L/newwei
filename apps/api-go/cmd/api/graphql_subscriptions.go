package main

import (
	"errors"
	"net"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/policy"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlsubscriptions"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

var errGraphQLSubscriptionsResources = errors.New("api-go: GraphQL subscriptions require mysql, jwt, and redis")

// newRedisOptions is the shared connection configuration for the command
// client, the dedicated blocking stream reader and the queue jobctx cache.
// RESP2 keeps HGETALL field order identical to ioredis.
func newRedisOptions(cfg config.Config) *redis.Options {
	return &redis.Options{
		Addr:     net.JoinHostPort(cfg.RedisHost, strconv.Itoa(cfg.RedisPort)),
		Username: cfg.RedisUsername,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
		Protocol: 2,
	}
}

// wireGraphQLSubscriptions builds the local graphql-transport-ws executor. It
// registers no HTTP route itself; main registers the exact /graphql
// entrypoint that routes only legal upgrades here and keeps every other
// method/operation on the Go read handler.
func wireGraphQLSubscriptions(
	cfg config.Config,
	authenticator *authhttp.Authenticator,
	redisClient *redis.Client,
	limiter *policy.Limiter,
	redisOptions *redis.Options,
) (*graphqlsubscriptions.Runtime, error) {
	if redisClient == nil {
		return nil, errGraphQLSubscriptionsResources
	}
	runtime, err := graphqlsubscriptions.New(graphqlsubscriptions.Options{
		Authenticator: authenticator,
		Limiter:       limiter,
		Redis:         redisClient,
		RedisOptions:  redisOptions,
	})
	if err != nil {
		return nil, err
	}
	return runtime, nil
}

// graphqlEntrypoint decides the exact /graphql request family. A legal
// graphql-transport-ws upgrade goes to the local subscription runtime; every
// other request goes to the Go read handler. There is no legacy proxy
// fallback: when neither component can serve the request, a GraphQL protocol
// error is written directly.
func graphqlEntrypoint(
	subscriptions *graphqlsubscriptions.Runtime,
	readHandler *graphqlread.Handler,
) legacyproxy.GoHandler {
	return func(w http.ResponseWriter, request *http.Request) {
		if subscriptions != nil && subscriptions.Handles(request) {
			subscriptions.ServeHTTP(w, request)
			return
		}
		if readHandler != nil {
			readHandler.ServeHTTP(w, request)
			return
		}
		writeGraphQLNotConfigured(w)
	}
}

// writeGraphQLNotConfigured writes a GraphQL-over-HTTP protocol error when the
// entrypoint has no handler to serve the request.
func writeGraphQLNotConfigured(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"errors":[{"message":"GraphQL endpoint is not configured","extensions":{"code":"INTERNAL_SERVER_ERROR","http":{"status":500}}}]}`))
}
