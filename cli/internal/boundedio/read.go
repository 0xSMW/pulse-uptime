// Package boundedio reads local CLI inputs without allowing them to grow
// without limit in memory.
package boundedio

import (
	"bufio"
	"errors"
	"io"
	"os"
)

var ErrTooLarge = errors.New("input exceeds size limit")

// ReadAll reads at most maxBytes and reports ErrTooLarge when another byte is
// available.
func ReadAll(r io.Reader, maxBytes int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrTooLarge
	}
	return data, nil
}

// ReadFile opens path and applies the same bound as ReadAll.
func ReadFile(path string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ReadAll(f, maxBytes)
}

// ReadLine reads one line with a byte limit that excludes its line ending.
func ReadLine(r io.Reader, maxBytes int64) (string, error) {
	line, err := bufio.NewReader(io.LimitReader(r, maxBytes+2)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	content := line
	if len(content) > 0 && content[len(content)-1] == '\n' {
		content = content[:len(content)-1]
		if len(content) > 0 && content[len(content)-1] == '\r' {
			content = content[:len(content)-1]
		}
	}
	if int64(len(content)) > maxBytes {
		return "", ErrTooLarge
	}
	return line, nil
}
