// Package paginator bounds and aggregates cursor-paginated CLI API results.
package paginator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
)

const (
	maxPages    = 1000
	maxRecords  = 100_000
	maxBytes    = 64 << 20
	maxPageSize = 100
)

type bounds struct {
	pages   int
	records int
	bytes   int
}

// Options describes the behavior shared by CLI list commands.
type Options struct {
	Query      url.Values
	Limit      int
	Cursor     string
	Follow     bool
	APIVersion string
	Kind       string
	PageName   string
	RecordName string
	LimitError func(string) error
}

// Page is one decoded API page. NextCursor points to the cursor carried by
// Meta while keeping paginator independent from each command's envelope type.
type Page[M any] struct {
	APIVersion string
	Kind       string
	Data       []json.RawMessage
	Meta       M
	NextCursor *string
}

// Result is the aggregated list data and the metadata from the last accepted
// page.
type Result[M any] struct {
	APIVersion string
	Kind       string
	Data       []json.RawMessage
	Meta       M
}

// Aggregate follows cursor pagination when Follow is set and enforces the CLI's
// fixed hostile-server bounds.
func Aggregate[M any](ctx context.Context, options Options, fetch func(context.Context, url.Values) (Page[M], error)) (Result[M], error) {
	return aggregate(ctx, options, bounds{pages: maxPages, records: maxRecords, bytes: maxBytes}, fetch)
}

func aggregate[M any](ctx context.Context, options Options, limits bounds, fetch func(context.Context, url.Values) (Page[M], error)) (Result[M], error) {
	query := cloneValues(options.Query)
	if options.Cursor != "" {
		query.Set("cursor", options.Cursor)
	}
	remaining := options.Limit
	result := Result[M]{APIVersion: options.APIVersion, Kind: options.Kind, Data: make([]json.RawMessage, 0)}
	seen := make(map[string]struct{})
	if options.Cursor != "" {
		seen[options.Cursor] = struct{}{}
	}
	totalBytes := 0
	for pages := 0; ; pages++ {
		if pages >= limits.pages {
			return Result[M]{}, limitError(options, fmt.Sprintf("server returned more %s pages than the client will follow", options.PageName))
		}
		if remaining > 0 {
			pageSize := min(remaining, maxPageSize)
			query.Set("limit", strconv.Itoa(pageSize))
		}
		page, err := fetch(ctx, cloneValues(query))
		if err != nil {
			return Result[M]{}, err
		}
		accepted := page.Data
		if remaining > 0 && len(accepted) > remaining {
			accepted = accepted[:remaining]
		}
		for _, raw := range accepted {
			totalBytes += len(raw)
		}
		if totalBytes > limits.bytes {
			return Result[M]{}, limitError(options, "server exceeded the maximum aggregate response size")
		}
		result.Data = append(result.Data, accepted...)
		if len(result.Data) > limits.records {
			return Result[M]{}, limitError(options, fmt.Sprintf("server returned more %s than the client will aggregate", options.RecordName))
		}
		result.Meta = page.Meta
		if page.APIVersion != "" {
			result.APIVersion = page.APIVersion
		}
		if page.Kind != "" {
			result.Kind = page.Kind
		}
		if remaining > 0 {
			remaining -= len(accepted)
			if remaining <= 0 {
				break
			}
		}
		if !options.Follow || page.NextCursor == nil || *page.NextCursor == "" {
			break
		}
		next := *page.NextCursor
		if _, exists := seen[next]; exists {
			return Result[M]{}, limitError(options, "server returned a repeating pagination cursor")
		}
		seen[next] = struct{}{}
		query.Set("cursor", next)
	}
	return result, nil
}

func cloneValues(values url.Values) url.Values {
	clone := make(url.Values, len(values))
	for key, entries := range values {
		clone[key] = append([]string(nil), entries...)
	}
	return clone
}

func limitError(options Options, message string) error {
	if options.LimitError == nil {
		return errors.New(message)
	}
	return options.LimitError(message)
}
