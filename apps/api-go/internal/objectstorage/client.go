package objectstorage

import (
	"context"
	"errors"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// requestIDHeaders are the S3 response headers carrying the request id, in the
// order the AWS SDK for JavaScript reads them.
var requestIDHeaders = []string{"x-amz-request-id", "x-amz-id-2"}

// CheckResult is the outcome of one diagnostic S3 operation. The zero value is
// a failed check with no details; OK is true only for a successful call.
type CheckResult struct {
	OK bool
	// Error is "<name>: <message>", the StorageService.formatAwsError shape.
	Error string
	// HTTPStatusCode is the service response status when one was received.
	HTTPStatusCode *int
	// RequestID is the service request id when the response carried one.
	RequestID *string
}

// Client wraps one S3 client built from one RuntimeConfig snapshot. It holds no
// configuration cache and reads no settings, so a single snapshot can sign any
// number of objects within one request.
type Client struct {
	cfg       RuntimeConfig
	client    *s3.Client
	presigner *s3.PresignClient
}

// NewClient builds the S3 client from the snapshot. It returns
// ErrIncompleteConfig (wrapped) when the completeness condition fails, so the
// caller can map it onto the NestJS BadRequestException.
func NewClient(cfg RuntimeConfig) (*Client, error) {
	if !cfg.Complete() {
		return nil, ErrIncompleteConfig
	}
	s3Client := s3.NewFromConfig(aws.Config{
		Region: cfg.EffectiveRegion(),
		// Explicit static credentials only: no default credential chain, no
		// shared config file and no instance-metadata probe.
		Credentials: credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
	}, func(options *s3.Options) {
		options.UsePathStyle = cfg.ForcePathStyle
		if cfg.Endpoint != "" {
			options.BaseEndpoint = aws.String(cfg.Endpoint)
		}
	})
	return &Client{
		cfg:       cfg,
		client:    s3Client,
		presigner: s3.NewPresignClient(s3Client),
	}, nil
}

// Configuration returns the snapshot the client was built from.
func (c *Client) Configuration() RuntimeConfig {
	if c == nil {
		return RuntimeConfig{}
	}
	return c.cfg
}

// CreateObjectReadURL presigns a GET for objectKey using the record's own key.
// The response parameters are part of the signature, so they are set on the
// request rather than appended afterwards. The key is passed through unchanged:
// the SDK performs the single, correct percent-encoding (Chinese characters,
// spaces, plus signs, percent signs and slashes included).
func (c *Client) CreateObjectReadURL(ctx context.Context, objectKey string, opts ReadURLOptions) (string, error) {
	if c == nil || c.presigner == nil {
		return "", ErrIncompleteConfig
	}
	input := &s3.GetObjectInput{
		Bucket: aws.String(c.cfg.Bucket),
		Key:    aws.String(objectKey),
	}
	if opts.ResponseContentType != "" {
		input.ResponseContentType = aws.String(opts.ResponseContentType)
	}
	if opts.ResponseContentDisposition != "" {
		input.ResponseContentDisposition = aws.String(opts.ResponseContentDisposition)
	}
	if opts.ResponseCacheControl != "" {
		input.ResponseCacheControl = aws.String(opts.ResponseCacheControl)
	}
	request, err := c.presigner.PresignGetObject(ctx, input,
		s3.WithPresignExpires(presignExpiry(c.cfg.effectiveTTLSeconds(opts))))
	if err != nil {
		return "", err
	}
	if request == nil || request.URL == "" {
		return "", errors.New("object storage: presigner returned no url")
	}
	return request.URL, nil
}

// HeadBucket probes bucket reachability with the caller's credentials.
func (c *Client) HeadBucket(ctx context.Context) CheckResult {
	if c == nil || c.client == nil {
		return CheckResult{Error: IncompleteConfigText}
	}
	_, err := c.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(c.cfg.Bucket)})
	return checkResult(err)
}

// PutObject writes one small probe object into the bucket.
func (c *Client) PutObject(ctx context.Context, objectKey, body, contentType, cacheControl string) CheckResult {
	if c == nil || c.client == nil {
		return CheckResult{Error: IncompleteConfigText}
	}
	input := &s3.PutObjectInput{
		Bucket: aws.String(c.cfg.Bucket),
		Key:    aws.String(objectKey),
		Body:   strings.NewReader(body),
	}
	if contentType != "" {
		input.ContentType = aws.String(contentType)
	}
	if cacheControl != "" {
		input.CacheControl = aws.String(cacheControl)
	}
	_, err := c.client.PutObject(ctx, input)
	return checkResult(err)
}

// DeleteObject removes exactly the probe object this run wrote.
func (c *Client) DeleteObject(ctx context.Context, objectKey string) CheckResult {
	if c == nil || c.client == nil {
		return CheckResult{Error: IncompleteConfigText}
	}
	_, err := c.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.cfg.Bucket),
		Key:    aws.String(objectKey),
	})
	return checkResult(err)
}

// checkResult converts one SDK call outcome into a CheckResult.
func checkResult(err error) CheckResult {
	if err == nil {
		return CheckResult{OK: true}
	}
	result := CheckResult{Error: formatAWSError(err)}
	var responseErr *smithyhttp.ResponseError
	if errors.As(err, &responseErr) && responseErr.Response != nil && responseErr.Response.Response != nil {
		status := responseErr.HTTPStatusCode()
		result.HTTPStatusCode = &status
		header := responseErr.Response.Header
		for _, name := range requestIDHeaders {
			if requestID := strings.TrimSpace(header.Get(name)); requestID != "" {
				result.RequestID = &requestID
				break
			}
		}
	}
	return result
}

// formatAWSError mirrors StorageService.formatAwsError: the API error code and
// message when the SDK reported one, otherwise "Error: <message>". The text
// never contains credentials or a presigned URL.
func formatAWSError(err error) string {
	name := "Error"
	message := "Unknown error"
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		if code := strings.TrimSpace(apiErr.ErrorCode()); code != "" {
			name = code
		}
		if text := apiErr.ErrorMessage(); text != "" {
			message = text
		}
	} else if err != nil {
		message = err.Error()
	}
	return name + ": " + message
}
