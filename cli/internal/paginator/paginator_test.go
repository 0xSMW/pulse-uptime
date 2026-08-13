package paginator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"strconv"
	"testing"
)

type testMeta struct {
	RequestID  string
	NextCursor *string
}

type boundedError struct{ message string }

func (e *boundedError) Error() string { return e.message }

func TestAggregateContract(t *testing.T) {
	tests := []struct {
		name        string
		options     Options
		pages       []Page[testMeta]
		wantIDs     []string
		wantQueries []url.Values
		wantMeta    testMeta
	}{
		{
			name:    "machine output follows cursors and keeps filters",
			options: Options{Query: url.Values{"state": {"down"}}, Cursor: "start", Follow: true, PageName: "monitor", RecordName: "monitors", LimitError: newLimitError},
			pages: []Page[testMeta]{
				page("v1", "MonitorList", "req-1", "next", "one"),
				page("v2", "NewMonitorList", "req-2", "", "two"),
			},
			wantIDs: []string{"one", "two"},
			wantQueries: []url.Values{
				{"state": {"down"}, "cursor": {"start"}},
				{"state": {"down"}, "cursor": {"next"}},
			},
			wantMeta: testMeta{RequestID: "req-2", NextCursor: stringPointer("")},
		},
		{
			name:    "human output stops after one page",
			options: Options{Follow: false, PageName: "group", RecordName: "groups", LimitError: newLimitError},
			pages: []Page[testMeta]{
				page("v1", "GroupList", "req-1", "next", "one"),
				page("v1", "GroupList", "req-2", "", "two"),
			},
			wantIDs:     []string{"one"},
			wantQueries: []url.Values{{}},
			wantMeta:    testMeta{RequestID: "req-1", NextCursor: stringPointer("next")},
		},
		{
			name:    "limit caps page size and retains server cursor",
			options: Options{Limit: 2, Follow: true, PageName: "incident", RecordName: "incidents", LimitError: newLimitError},
			pages: []Page[testMeta]{
				page("v1", "IncidentList", "req-1", "next", "one", "two", "three"),
			},
			wantIDs:     []string{"one", "two"},
			wantQueries: []url.Values{{"limit": {"2"}}},
			wantMeta:    testMeta{RequestID: "req-1", NextCursor: stringPointer("next")},
		},
		{
			name:        "page size never exceeds one hundred",
			options:     Options{Limit: 101, Follow: true, PageName: "report", RecordName: "reports", LimitError: newLimitError},
			pages:       []Page[testMeta]{page("v1", "StatusReportList", "req-1", "", "one")},
			wantIDs:     []string{"one"},
			wantQueries: []url.Values{{"limit": {"100"}}},
			wantMeta:    testMeta{RequestID: "req-1", NextCursor: stringPointer("")},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var queries []url.Values
			calls := 0
			result, err := Aggregate(context.Background(), tc.options, func(_ context.Context, query url.Values) (Page[testMeta], error) {
				queries = append(queries, query)
				if calls >= len(tc.pages) {
					t.Fatal("unexpected extra page request")
				}
				value := tc.pages[calls]
				calls++
				return value, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if got := ids(t, result.Data); !reflect.DeepEqual(got, tc.wantIDs) {
				t.Fatalf("ids = %v, want %v", got, tc.wantIDs)
			}
			if !reflect.DeepEqual(queries, tc.wantQueries) {
				t.Fatalf("queries = %#v, want %#v", queries, tc.wantQueries)
			}
			if result.APIVersion != tc.pages[calls-1].APIVersion || result.Kind != tc.pages[calls-1].Kind || !reflect.DeepEqual(result.Meta, tc.wantMeta) {
				t.Fatalf("metadata = %#v, want apiVersion=%q kind=%q meta=%#v", result, tc.pages[calls-1].APIVersion, tc.pages[calls-1].Kind, tc.wantMeta)
			}
		})
	}
}

func TestAggregateRejectsRepeatedCursor(t *testing.T) {
	calls := 0
	_, err := Aggregate(context.Background(), Options{Follow: true, PageName: "dependency", RecordName: "dependencies", LimitError: newLimitError}, func(context.Context, url.Values) (Page[testMeta], error) {
		calls++
		return page("v1", "DependencyList", "req", "same", strconv.Itoa(calls)), nil
	})
	var bounded *boundedError
	if !errors.As(err, &bounded) || bounded.message != "server returned a repeating pagination cursor" {
		t.Fatalf("error = %#v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2", calls)
	}
}

func TestAggregateEnforcesPageRecordAndByteCaps(t *testing.T) {
	tests := []struct {
		name      string
		page      func(int) Page[testMeta]
		want      string
		wantCalls int
	}{
		{
			name: "pages",
			page: func(call int) Page[testMeta] {
				return page("v1", "TokenList", "req", fmt.Sprintf("cursor-%d", call), "one")
			},
			want:      "server returned more token pages than the client will follow",
			wantCalls: maxPages,
		},
		{
			name: "records",
			page: func(call int) Page[testMeta] {
				items := make([]json.RawMessage, 11)
				for i := range items {
					items[i] = json.RawMessage(`{}`)
				}
				return Page[testMeta]{Data: items, Meta: testMeta{}, NextCursor: stringPointer("")}
			},
			want:      "server returned more tokens than the client will aggregate",
			wantCalls: 1,
		},
		{
			name: "bytes",
			page: func(call int) Page[testMeta] {
				return Page[testMeta]{Data: []json.RawMessage{json.RawMessage(make([]byte, 11))}, Meta: testMeta{}, NextCursor: stringPointer("")}
			},
			want:      "server exceeded the maximum aggregate response size",
			wantCalls: 1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			limits := bounds{pages: maxPages, records: maxRecords, bytes: maxBytes}
			if tc.name == "records" {
				limits.records = 10
			}
			if tc.name == "bytes" {
				limits.bytes = 10
			}
			_, err := aggregate(context.Background(), Options{Follow: true, PageName: "token", RecordName: "tokens", LimitError: newLimitError}, limits, func(context.Context, url.Values) (Page[testMeta], error) {
				calls++
				return tc.page(calls), nil
			})
			var bounded *boundedError
			if !errors.As(err, &bounded) || bounded.message != tc.want {
				t.Fatalf("error = %#v, want %q", err, tc.want)
			}
			if calls != tc.wantCalls {
				t.Fatalf("calls = %d, want %d", calls, tc.wantCalls)
			}
		})
	}
}

func page(apiVersion, kind, requestID, next string, values ...string) Page[testMeta] {
	data := make([]json.RawMessage, 0, len(values))
	for _, value := range values {
		data = append(data, json.RawMessage(fmt.Sprintf(`{"id":%q}`, value)))
	}
	nextCursor := stringPointer(next)
	return Page[testMeta]{APIVersion: apiVersion, Kind: kind, Data: data, Meta: testMeta{RequestID: requestID, NextCursor: nextCursor}, NextCursor: nextCursor}
}

func ids(t *testing.T, values []json.RawMessage) []string {
	t.Helper()
	result := make([]string, 0, len(values))
	for _, value := range values {
		var item struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(value, &item); err != nil {
			t.Fatal(err)
		}
		result = append(result, item.ID)
	}
	return result
}

func stringPointer(value string) *string { return &value }

func newLimitError(message string) error { return &boundedError{message: message} }
