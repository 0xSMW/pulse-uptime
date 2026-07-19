// Package progress renders a single-glyph braille spinner on a writer while a
// request is in flight. The spinner is silent by design, no text is ever
// printed next to the animating rune.
package progress

import (
	"fmt"
	"io"
	"sync"
	"time"
)

var frames = []rune("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")

// Spinner animates a single braille rune at column 0 until Stop is called.
type Spinner struct {
	w    io.Writer
	stop chan struct{}
	wg   sync.WaitGroup
	once sync.Once
}

// Start animates a single braille rune at the cursor on w. The first frame
// is written before any tick, so feedback is immediate. A nil writer yields
// a no-op spinner whose Stop is still safe to call.
func Start(w io.Writer) *Spinner {
	s := &Spinner{w: w, stop: make(chan struct{})}
	if w == nil {
		return s
	}
	s.wg.Add(1)
	go s.run()
	return s
}

func (s *Spinner) run() {
	defer s.wg.Done()
	t := time.NewTicker(80 * time.Millisecond)
	defer t.Stop()
	for i := 0; ; i++ {
		fmt.Fprintf(s.w, "\r%c", frames[i%len(frames)])
		select {
		case <-s.stop:
			fmt.Fprint(s.w, "\r\x1b[K")
			return
		case <-t.C:
		}
	}
}

// Stop erases the glyph and blocks until the erase has been written, so the
// caller can print to stdout without interleaving.
func (s *Spinner) Stop() {
	s.once.Do(func() {
		if s.w == nil {
			return
		}
		close(s.stop)
		s.wg.Wait()
	})
}
