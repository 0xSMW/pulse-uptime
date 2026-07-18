package statuspageops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

type transportFunc func(context.Context, string, string, any, http.Header, any) (http.Header, error)

func (f transportFunc) Do(ctx context.Context, method, path string, body any, headers http.Header, out any) (http.Header, error) {
	return f(ctx, method, path, body, headers, out)
}

const configJSON = `{
	"name":"System Status","layout":"vertical","theme":"system",
	"logoLightImageId":null,"logoDarkImageId":null,"faviconImageId":null,
	"homepageUrl":null,"contactUrl":"mailto:ops@example.com",
	"navLinks":[{"label":"Docs","url":"https://docs.example.com"}],
	"googleTagId":null,"customCss":null,"customHead":null,
	"announcementEnabled":false,"announcementMarkdown":null,
	"historyDays":90,"uptimeDecimals":2,"unknownAsOperational":false,
	"minIncidentSeconds":0,"timezone":null,
	"updatedAt":"2026-07-18T00:00:00Z"
}`

func serveConfig(t *testing.T, etag string, onPut func(body any, headers http.Header)) Transport {
	t.Helper()
	return transportFunc(func(_ context.Context, method, path string, body any, headers http.Header, out any) (http.Header, error) {
		if path != "/api/v1/status-page-config" {
			t.Fatalf("path=%q", path)
		}
		switch method {
		case http.MethodGet:
			doc := out.(*envelope)
			doc.APIVersion = "v1"
			doc.Kind = "StatusPageConfig"
			doc.Data = json.RawMessage(configJSON)
			response := http.Header{}
			response.Set("ETag", etag)
			return response, nil
		case http.MethodPut:
			if onPut == nil {
				t.Fatal("unexpected PUT")
			}
			onPut(body, headers)
			doc := out.(*envelope)
			doc.APIVersion = "v1"
			doc.Kind = "StatusPageConfig"
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			doc.Data = encoded
			return http.Header{}, nil
		default:
			t.Fatalf("method=%q", method)
			return nil, nil
		}
	})
}

func run(t *testing.T, d Dependencies, args ...string) error {
	t.Helper()
	cmd := NewGroup(d)
	cmd.SetArgs(args)
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	return cmd.Execute()
}

func TestGetRendersOrderedFieldListing(t *testing.T) {
	var out bytes.Buffer
	d := Dependencies{Client: serveConfig(t, `W/"abc"`, nil), Out: &out, Output: func(string) string { return "table" }}
	if err := run(t, d, "get"); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	wantOrder := []struct{ field, value string }{
		{"name", "System Status"},
		{"layout", "vertical"},
		{"theme", "system"},
		{"logoLightImageId", "-"},
		{"logoDarkImageId", "-"},
		{"faviconImageId", "-"},
		{"homepageUrl", "-"},
		{"contactUrl", "mailto:ops@example.com"},
		{"navLinks", `[{"label":"Docs","url":"https://docs.example.com"}]`},
		{"googleTagId", "-"},
		{"customCss", "-"},
		{"customHead", "-"},
		{"announcementEnabled", "false"},
		{"announcementMarkdown", "-"},
		{"historyDays", "90"},
		{"uptimeDecimals", "2"},
		{"unknownAsOperational", "false"},
		{"minIncidentSeconds", "0"},
		{"timezone", "-"},
		{"updatedAt", "2026-07-18T00:00:00Z"},
	}
	if len(lines) != len(wantOrder) {
		t.Fatalf("lines=%d output=%q", len(lines), out.String())
	}
	for i, want := range wantOrder {
		expected := fmt.Sprintf("%-22s  %s", want.field+":", want.value)
		if lines[i] != expected {
			t.Fatalf("line %d = %q, want %q", i, lines[i], expected)
		}
	}
}

func TestGetJSONPreservesEnvelope(t *testing.T) {
	var out bytes.Buffer
	d := Dependencies{Client: serveConfig(t, `W/"abc"`, nil), Out: &out, Output: func(string) string { return "table" }}
	if err := run(t, d, "get", "--json"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"kind": "StatusPageConfig"`) || !strings.Contains(out.String(), `"historyDays": 90`) {
		t.Fatalf("output=%s", out.String())
	}
}

func TestSetSendsFullDocumentWithIfMatch(t *testing.T) {
	var putBody map[string]any
	var putHeaders http.Header
	client := serveConfig(t, `W/"abc"`, func(body any, headers http.Header) {
		putBody = body.(map[string]any)
		putHeaders = headers
	})
	var out bytes.Buffer
	d := Dependencies{Client: client, Out: &out, Output: func(string) string { return "table" }}
	if err := run(t, d, "set", "name=Acme Status", "historyDays=60", "announcementEnabled=true", "timezone=", "layout=horizontal"); err != nil {
		t.Fatal(err)
	}
	if putHeaders.Get("If-Match") != `W/"abc"` {
		t.Fatalf("If-Match=%q", putHeaders.Get("If-Match"))
	}
	if putBody["name"] != "Acme Status" || putBody["layout"] != "horizontal" {
		t.Fatalf("body=%v", putBody)
	}
	if value, ok := putBody["historyDays"].(int); !ok || value != 60 {
		t.Fatalf("historyDays=%v", putBody["historyDays"])
	}
	if putBody["announcementEnabled"] != true {
		t.Fatalf("announcementEnabled=%v", putBody["announcementEnabled"])
	}
	if value, present := putBody["timezone"]; !present || value != nil {
		t.Fatalf("timezone=%v present=%v", value, present)
	}
	if _, present := putBody["updatedAt"]; present {
		t.Fatal("updatedAt was not stripped from the PUT body")
	}
	if _, present := putBody["navLinks"]; !present {
		t.Fatal("full document PUT must preserve navLinks")
	}
}

func TestSetValidatesFields(t *testing.T) {
	client := serveConfig(t, `W/"abc"`, func(any, http.Header) { t.Fatal("PUT sent for invalid input") })
	cases := [][]string{
		{"set", "navLinks=[]"},
		{"set", "unknownField=1"},
		{"set", "layout=diagonal"},
		{"set", "historyDays=45"},
		{"set", "uptimeDecimals=9"},
		{"set", "minIncidentSeconds=-1"},
		{"set", "minIncidentSeconds=604801"},
		{"set", "announcementEnabled=maybe"},
		{"set", "name="},
		{"set", "broken"},
	}
	for _, args := range cases {
		err := run(t, Dependencies{Client: client}, args...)
		var typed *Error
		if !errors.As(err, &typed) || typed.Exit != exitInvalidInput {
			t.Fatalf("args=%v err=%v", args, err)
		}
	}
}

func TestSetMinIncidentSecondsMatchesServerBounds(t *testing.T) {
	var putBody map[string]any
	client := serveConfig(t, `W/"abc"`, func(body any, _ http.Header) { putBody = body.(map[string]any) })
	if err := run(t, Dependencies{Client: client, Out: io.Discard}, "set", "minIncidentSeconds=604800"); err != nil {
		t.Fatal(err)
	}
	if value, ok := putBody["minIncidentSeconds"].(int); !ok || value != 604800 {
		t.Fatalf("minIncidentSeconds=%v", putBody["minIncidentSeconds"])
	}
	err := run(t, Dependencies{Client: serveConfig(t, `W/"abc"`, func(any, http.Header) { t.Fatal("PUT sent") })}, "set", "minIncidentSeconds=604801")
	var typed *Error
	if !errors.As(err, &typed) || typed.Exit != exitInvalidInput {
		t.Fatalf("err=%v", err)
	}
	if typed.Message != "minIncidentSeconds must be between 0 and 604800" {
		t.Fatalf("message=%q", typed.Message)
	}
}

func TestExportWritesETagFirstAndRoundTrips(t *testing.T) {
	var out bytes.Buffer
	d := Dependencies{Client: serveConfig(t, `W/"abc"`, nil), Out: &out, Output: func(string) string { return "json" }}
	if err := run(t, d, "export"); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatalf("export is not valid JSON: %v\n%s", err, out.String())
	}
	if decoded["_etag"] != `W/"abc"` || decoded["name"] != "System Status" {
		t.Fatalf("decoded=%v", decoded)
	}
	first := strings.Index(out.String(), `"_etag"`)
	if first < 0 || first > strings.Index(out.String(), `"name"`) {
		t.Fatalf("_etag is not the first field:\n%s", out.String())
	}
}

func TestExportToFileUsesCreate(t *testing.T) {
	var file bytes.Buffer
	created := ""
	d := Dependencies{
		Client: serveConfig(t, `W/"abc"`, nil),
		Create: func(path string, force bool) (io.WriteCloser, error) {
			created = path
			return nopCloser{&file}, nil
		},
		Output: func(string) string { return "json" },
	}
	if err := run(t, d, "export", "--file", "status-page.json"); err != nil {
		t.Fatal(err)
	}
	if created != "status-page.json" || !strings.Contains(file.String(), `"_etag"`) {
		t.Fatalf("created=%q content=%q", created, file.String())
	}
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }

func TestApplySendsIfMatchFromFileAndStripsUnderscore(t *testing.T) {
	var putBody map[string]any
	var putHeaders http.Header
	client := serveConfig(t, `W/"abc"`, func(body any, headers http.Header) {
		putBody = body.(map[string]any)
		putHeaders = headers
	})
	exported := `{"_etag":"W/\"abc\"","name":"Acme Status","layout":"vertical","navLinks":[],"historyDays":30,"updatedAt":"2026-07-18T00:00:00Z"}`
	d := Dependencies{
		Client:   client,
		ReadFile: func(string) ([]byte, error) { return []byte(exported), nil },
		Output:   func(string) string { return "json" },
		Out:      io.Discard,
	}
	if err := run(t, d, "apply", "--file", "status-page.json"); err != nil {
		t.Fatal(err)
	}
	if putHeaders.Get("If-Match") != `W/"abc"` {
		t.Fatalf("If-Match=%q", putHeaders.Get("If-Match"))
	}
	if _, present := putBody["_etag"]; present {
		t.Fatal("_etag was not stripped from the PUT body")
	}
	if _, present := putBody["updatedAt"]; present {
		t.Fatal("updatedAt was not stripped from the PUT body")
	}
	if putBody["name"] != "Acme Status" {
		t.Fatalf("body=%v", putBody)
	}
}

func TestApplyReadsStdin(t *testing.T) {
	var putBody map[string]any
	client := serveConfig(t, `W/"abc"`, func(body any, _ http.Header) { putBody = body.(map[string]any) })
	d := Dependencies{
		Client: client,
		In:     strings.NewReader(`{"_etag":"W/\"abc\"","name":"Piped"}`),
		Output: func(string) string { return "json" },
		Out:    io.Discard,
	}
	if err := run(t, d, "apply", "--file", "-"); err != nil {
		t.Fatal(err)
	}
	if putBody["name"] != "Piped" {
		t.Fatalf("body=%v", putBody)
	}
}

func TestApplyWithoutEtagFails(t *testing.T) {
	d := Dependencies{
		Client:   serveConfig(t, `W/"abc"`, func(any, http.Header) { t.Fatal("PUT sent") }),
		ReadFile: func(string) ([]byte, error) { return []byte(`{"name":"Acme"}`), nil },
	}
	err := run(t, d, "apply", "--file", "status-page.json")
	var typed *Error
	if !errors.As(err, &typed) || typed.Exit != exitInvalidInput || !strings.Contains(typed.Message, "_etag") {
		t.Fatalf("err=%v", err)
	}
}

func TestApplyConflictAddsReexportGuidance(t *testing.T) {
	client := transportFunc(func(_ context.Context, method, _ string, _ any, _ http.Header, out any) (http.Header, error) {
		if method == http.MethodPut {
			return nil, &Error{Exit: exitConflict, Code: "PRECONDITION_FAILED", Message: "configuration was modified"}
		}
		t.Fatalf("unexpected %s", method)
		return nil, nil
	})
	d := Dependencies{
		Client:   client,
		ReadFile: func(string) ([]byte, error) { return []byte(`{"_etag":"W/\"stale\"","name":"Acme"}`), nil },
	}
	err := run(t, d, "apply", "--file", "status-page.json")
	var typed *Error
	if !errors.As(err, &typed) || typed.Exit != exitConflict {
		t.Fatalf("err=%v", err)
	}
	if typed.Code != "PRECONDITION_FAILED" || !strings.Contains(typed.Message, "re-run pulsectl status-page export") {
		t.Fatalf("message=%q code=%q", typed.Message, typed.Code)
	}
}

func TestGetWithoutETagFails(t *testing.T) {
	client := transportFunc(func(_ context.Context, _, _ string, _ any, _ http.Header, out any) (http.Header, error) {
		doc := out.(*envelope)
		doc.Data = json.RawMessage(`{}`)
		return http.Header{}, nil
	})
	err := run(t, Dependencies{Client: client}, "get")
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != "INVALID_RESPONSE" {
		t.Fatalf("err=%v", err)
	}
}
