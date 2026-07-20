package progress

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer guards a bytes.Buffer with a mutex since the spinner goroutine
// writes concurrently with the test's reads.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestStartWritesFirstFrameImmediately(t *testing.T) {
	t.Parallel()
	w := &syncBuffer{}
	s := Start(w)
	defer s.Stop()
	deadline := time.Now().Add(50 * time.Millisecond)
	for w.String() == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	got := w.String()
	if got == "" {
		t.Fatal("no frame written before the first tick")
	}
	if !strings.HasPrefix(got, "\r") {
		t.Fatalf("first frame = %q, want prefix \\r", got)
	}
}

func TestStopErasesWithFinalBytes(t *testing.T) {
	t.Parallel()
	w := &syncBuffer{}
	s := Start(w)
	time.Sleep(10 * time.Millisecond)
	s.Stop()
	got := w.String()
	if !strings.HasSuffix(got, "\r\x1b[K") {
		t.Fatalf("output = %q, want suffix \\r\\x1b[K", got)
	}
}

func TestStopIsIdempotent(t *testing.T) {
	t.Parallel()
	w := &syncBuffer{}
	s := Start(w)
	s.Stop()
	s.Stop()
}

func TestStartNilWriterStopDoesNotPanic(t *testing.T) {
	t.Parallel()
	s := Start(nil)
	s.Stop()
	s.Stop()
}
