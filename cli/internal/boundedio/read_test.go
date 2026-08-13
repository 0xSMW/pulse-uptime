package boundedio

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadAllChecksOneBytePastLimit(t *testing.T) {
	got, err := ReadAll(strings.NewReader("1234"), 4)
	if err != nil || string(got) != "1234" {
		t.Fatalf("exact limit: got %q, err %v", got, err)
	}
	if _, err := ReadAll(strings.NewReader("12345"), 4); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize error = %v", err)
	}
}

func TestReadFileChecksOneBytePastLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "input")
	if err := os.WriteFile(path, []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(path, 4); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize error = %v", err)
	}
}

func TestReadLineExcludesLineEndingFromLimit(t *testing.T) {
	got, err := ReadLine(strings.NewReader("1234\r\nignored"), 4)
	if err != nil || got != "1234\r\n" {
		t.Fatalf("line = %q, err %v", got, err)
	}
	if _, err := ReadLine(strings.NewReader("12345\n"), 4); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize error = %v", err)
	}
}
