//go:build !windows

package atomicexport

import (
	"fmt"
	"os"
)

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open export directory for sync: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync export directory: %w", err)
	}
	return nil
}
