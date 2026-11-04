// Package mongodb owns the process-wide Mongo client. The gateway opens exactly
// one client at startup and hands the same *Client to every Mongo-backed unit;
// units never open their own client, so shutdown ordering and connection
// ownership live in one place.
package mongodb

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Client is the shared Mongo client. It carries the database name parsed from
// the URI path; the connection pool is shared by every collection handle derived
// from Database.
type Client struct {
	client *mongo.Client
	dbName string
}

// Database returns the database named in the URI path. A nil client yields nil.
func (c *Client) Database() *mongo.Database {
	if c == nil || c.client == nil {
		return nil
	}
	return c.client.Database(c.dbName)
}

// Open builds the single process Mongo client. The server-selection timeout is
// 5s, matching the previous dashboard stats timeout. The returned error never
// contains the connection string.
func Open(uri string) (*Client, error) {
	dbName, err := parseMongoDatabase(uri)
	if err != nil {
		return nil, err
	}
	client, err := mongo.Connect(
		options.Client().
			ApplyURI(uri).
			SetServerSelectionTimeout(5 * time.Second),
	)
	if err != nil {
		return nil, errors.New("MONGO_URI was rejected")
	}
	return &Client{client: client, dbName: dbName}, nil
}

// Disconnect closes the shared client. The error may contain a server address,
// so callers must not write it into a response.
func (c *Client) Disconnect(ctx context.Context) error {
	if c == nil || c.client == nil {
		return nil
	}
	return c.client.Disconnect(ctx)
}

// parseMongoDatabase accepts only mongodb / mongodb+srv and requires exactly one
// database name in the path. Failure text is a fixed sentence; it never echoes
// the username, password or host.
func parseMongoDatabase(uri string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(uri))
	if err != nil || parsed.Host == "" {
		return "", errors.New("MONGO_URI is not a valid mongodb URL")
	}
	switch parsed.Scheme {
	case "mongodb", "mongodb+srv":
	default:
		return "", errors.New("MONGO_URI is not a valid mongodb URL")
	}
	name := strings.Trim(parsed.Path, "/")
	if name == "" || strings.Contains(name, "/") {
		return "", errors.New("MONGO_URI is missing a database name")
	}
	return name, nil
}
