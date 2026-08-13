package atomicexport

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteCreatesPrivateCompleteExport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := Write(path, false, func(w io.Writer) error {
		_, err := io.WriteString(w, "version: 2\n")
		return err
	}); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "version: 2\n" {
		t.Fatalf("content = %q", data)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %04o", got)
	}
}

func TestWriteForceReplacesRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "status-page.json")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, true, func(w io.Writer) error {
		_, err := io.WriteString(w, "new")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Fatalf("content = %q", data)
	}
}

func TestWriteRejectsSymlinkDestination(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	link := filepath.Join(dir, "export")
	if err := os.WriteFile(target, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	err := Write(link, true, func(w io.Writer) error {
		_, writeErr := io.WriteString(w, "replace")
		return writeErr
	})
	if err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("error = %v", err)
	}
	data, readErr := os.ReadFile(target)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "keep" {
		t.Fatalf("target content = %q", data)
	}
}

func TestWriteRejectsNonRegularDestination(t *testing.T) {
	path := filepath.Join(t.TempDir(), "export")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	err := Write(path, true, func(io.Writer) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("error = %v", err)
	}
}

func TestWriteFailurePreservesExistingDestination(t *testing.T) {
	path := filepath.Join(t.TempDir(), "export")
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := Write(path, true, func(w io.Writer) error {
		if _, writeErr := io.WriteString(w, "partial"); writeErr != nil {
			return writeErr
		}
		return io.ErrUnexpectedEOF
	})
	if err == nil {
		t.Fatal("expected writer failure")
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "original" {
		t.Fatalf("content = %q", data)
	}
}

func TestWriteRejectsDestinationSwapDuringForce(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "export")
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := Write(path, true, func(w io.Writer) error {
		if _, writeErr := io.WriteString(w, "new"); writeErr != nil {
			return writeErr
		}
		if removeErr := os.Remove(path); removeErr != nil {
			return removeErr
		}
		return os.WriteFile(path, []byte("racer"), 0o600)
	})
	if err == nil || !strings.Contains(err.Error(), "changed while writing") {
		t.Fatalf("error = %v", err)
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "racer" {
		t.Fatalf("content = %q", data)
	}
}

func TestRetainedDestinationIdentityDetectsRapidInodeReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "export")
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	destination, err := inspectDestination(path)
	if err != nil {
		t.Fatal(err)
	}
	defer destination.close()

	for attempt := 0; attempt < 100; attempt++ {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("racer"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := destination.verifyUnchanged(path); err == nil {
			t.Fatalf("replacement %d reused retained destination identity", attempt)
		}
	}
}

func TestWriteNoForceLosesRaceWithoutClobbering(t *testing.T) {
	path := filepath.Join(t.TempDir(), "export")
	err := Write(path, false, func(w io.Writer) error {
		if _, writeErr := io.WriteString(w, "new"); writeErr != nil {
			return writeErr
		}
		return os.WriteFile(path, []byte("racer"), 0o600)
	})
	if err == nil {
		t.Fatal("expected publish race to fail")
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "racer" {
		t.Fatalf("content = %q", data)
	}
}

func TestDirectorySyncFailureReportsPublishedExport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "export")
	syncErr := errors.New("directory sync unsupported")
	err := writeWithDirectorySync(path, false, func(w io.Writer) error {
		_, writeErr := io.WriteString(w, "complete")
		return writeErr
	}, func(string) error {
		return syncErr
	})

	var published *PublishedError
	if !errors.As(err, &published) {
		t.Fatalf("error = %v, want PublishedError", err)
	}
	if published.Path != path || !errors.Is(err, syncErr) {
		t.Fatalf("published error = %#v", published)
	}
	if !strings.Contains(err.Error(), "export was published") {
		t.Fatalf("error = %q", err)
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "complete" {
		t.Fatalf("content = %q", data)
	}
}
