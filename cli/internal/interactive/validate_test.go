package interactive

import (
	"io/fs"
	"os"
	"testing"
	"time"
)

func TestValidateRequired(t *testing.T) {
	v := ValidateRequired("name")
	if v("") == nil || v("   ") == nil {
		t.Fatal("empty input accepted")
	}
	if err := v("checkout"); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
}

func TestValidateURL(t *testing.T) {
	valid := []string{"https://example.com", "http://example.com/health", " https://example.com "}
	for _, s := range valid {
		if err := ValidateURL(s); err != nil {
			t.Fatalf("%q rejected: %v", s, err)
		}
	}
	invalid := []string{"", "example.com", "ftp://example.com", "https://", "not a url"}
	for _, s := range invalid {
		if ValidateURL(s) == nil {
			t.Fatalf("%q accepted", s)
		}
	}
	if ValidateOptionalURL("") != nil {
		t.Fatal("optional URL rejected empty")
	}
	if ValidateOptionalURL("example.com") == nil {
		t.Fatal("optional URL accepted bare host")
	}
}

func TestValidateDuration(t *testing.T) {
	if ValidateDuration("30s") != nil || ValidateDuration("5m") != nil {
		t.Fatal("valid duration rejected")
	}
	for _, s := range []string{"", "fast", "-5s", "0s"} {
		if ValidateDuration(s) == nil {
			t.Fatalf("%q accepted", s)
		}
	}
	if ValidateOptionalDuration("") != nil {
		t.Fatal("optional duration rejected empty")
	}
}

func TestValidatePositiveInt(t *testing.T) {
	if ValidatePositiveInt("3") != nil {
		t.Fatal("valid int rejected")
	}
	for _, s := range []string{"", "0", "-2", "two", "1.5"} {
		if ValidatePositiveInt(s) == nil {
			t.Fatalf("%q accepted", s)
		}
	}
	if ValidateOptionalPositiveInt("") != nil {
		t.Fatal("optional int rejected empty")
	}
}

func TestValidateIntRange(t *testing.T) {
	v := ValidateIntRange(0, 3)
	if v("0") != nil || v("3") != nil {
		t.Fatal("in-range value rejected")
	}
	for _, s := range []string{"-1", "4", "x", ""} {
		if v(s) == nil {
			t.Fatalf("%q accepted", s)
		}
	}
}

func TestValidateOptionalStatusRange(t *testing.T) {
	valid := []string{"", "200", "200-399", "100-599"}
	for _, s := range valid {
		if err := ValidateOptionalStatusRange(s); err != nil {
			t.Fatalf("%q rejected: %v", s, err)
		}
	}
	invalid := []string{"99", "600", "399-200", "20-399", "abc", "200-", "200-x"}
	for _, s := range invalid {
		if ValidateOptionalStatusRange(s) == nil {
			t.Fatalf("%q accepted", s)
		}
	}
}

func TestValidateOptionalRFC3339(t *testing.T) {
	if ValidateOptionalRFC3339("") != nil || ValidateOptionalRFC3339("2026-01-02T15:04:05Z") != nil {
		t.Fatal("valid timestamp rejected")
	}
	for _, s := range []string{"2026-01-02", "yesterday", "2026-01-02 15:04:05"} {
		if ValidateOptionalRFC3339(s) == nil {
			t.Fatalf("%q accepted", s)
		}
	}
}

func TestValidateExistingFile(t *testing.T) {
	restore := statFile
	defer func() { statFile = restore }()
	statFile = func(path string) (fs.FileInfo, error) {
		switch path {
		case "monitors.yaml":
			return fakeFileInfo{dir: false}, nil
		case "somedir":
			return fakeFileInfo{dir: true}, nil
		default:
			return nil, os.ErrNotExist
		}
	}
	if err := ValidateExistingFile("monitors.yaml"); err != nil {
		t.Fatalf("existing file rejected: %v", err)
	}
	if ValidateExistingFile("") == nil || ValidateExistingFile("missing.yaml") == nil || ValidateExistingFile("somedir") == nil {
		t.Fatal("invalid path accepted")
	}
}

func TestValidateOptionalEmail(t *testing.T) {
	if ValidateOptionalEmail("") != nil || ValidateOptionalEmail("oncall@example.com") != nil {
		t.Fatal("valid email rejected")
	}
	for _, s := range []string{"@example.com", "oncall@", "oncall", "on call@example.com"} {
		if ValidateOptionalEmail(s) == nil {
			t.Fatalf("%q accepted", s)
		}
	}
}

func TestValidateOptionalExpiry(t *testing.T) {
	if ValidateOptionalExpiry("") != nil || ValidateOptionalExpiry("90d") != nil {
		t.Fatal("valid expiry rejected")
	}
	for _, s := range []string{"soon", "0d", "400d"} {
		if ValidateOptionalExpiry(s) == nil {
			t.Fatalf("%q accepted", s)
		}
	}
}

type fakeFileInfo struct{ dir bool }

func (f fakeFileInfo) Name() string       { return "fake" }
func (f fakeFileInfo) Size() int64        { return 0 }
func (f fakeFileInfo) Mode() fs.FileMode  { return 0 }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return f.dir }
func (f fakeFileInfo) Sys() any           { return nil }
