// Package atomicexport safely publishes CLI export files.
package atomicexport

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Write stages an export in the destination directory and publishes it only
// after the complete file has been written and synced. Fresh no-clobber
// publication requires hard-link support from the destination filesystem. An
// unsupported hard link fails without creating the destination. A final
// directory-sync failure returns PublishedError because the file is visible.
func Write(path string, force bool, write func(io.Writer) error) error {
	return writeWithDirectorySync(path, force, write, syncDirectory)
}

// PublishedError reports a durability failure that happened after the export
// became visible at Path. Callers must not assume a returned error means the
// destination was left unchanged.
type PublishedError struct {
	Path string
	Err  error
}

func (e *PublishedError) Error() string {
	return fmt.Sprintf("export was published at %q but finalization failed: %v", e.Path, e.Err)
}

func (e *PublishedError) Unwrap() error { return e.Err }

func writeWithDirectorySync(path string, force bool, write func(io.Writer) error, syncDir func(string) error) error {
	if path == "" {
		return errors.New("export path is required")
	}
	if write == nil {
		return errors.New("export writer is required")
	}
	if syncDir == nil {
		return errors.New("directory sync is required")
	}

	original, err := inspectDestination(path)
	if err != nil {
		return err
	}
	if original.exists && !force {
		return fmt.Errorf("destination already exists")
	}

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".pulsectl-export-*")
	if err != nil {
		return fmt.Errorf("create temporary export: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("protect temporary export: %w", err)
	}
	if err := write(tmp); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temporary export: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary export: %w", err)
	}

	if force {
		if err := original.verifyUnchanged(path); err != nil {
			return err
		}
		if err := os.Rename(tmpPath, path); err != nil {
			return fmt.Errorf("replace export: %w", err)
		}
	} else {
		// A hard link publishes the staged inode only if the destination still
		// does not exist. This closes the portable no-clobber race.
		if err := os.Link(tmpPath, path); err != nil {
			return fmt.Errorf("publish export without overwrite: %w", err)
		}
		if err := os.Remove(tmpPath); err != nil {
			return &PublishedError{Path: path, Err: fmt.Errorf("remove temporary export link: %w", err)}
		}
	}

	if err := syncDir(dir); err != nil {
		return &PublishedError{Path: path, Err: err}
	}
	return nil
}

type destination struct {
	exists bool
	info   os.FileInfo
}

func inspectDestination(path string) (destination, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return destination{}, nil
	}
	if err != nil {
		return destination{}, fmt.Errorf("inspect export destination: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return destination{}, errors.New("export destination is a symlink")
	}
	if !info.Mode().IsRegular() {
		return destination{}, errors.New("export destination is not a regular file")
	}
	return destination{exists: true, info: info}, nil
}

func (d destination) verifyUnchanged(path string) error {
	current, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if d.exists {
			return errors.New("export destination changed while writing")
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("reinspect export destination: %w", err)
	}
	if current.Mode()&os.ModeSymlink != 0 {
		return errors.New("export destination became a symlink while writing")
	}
	if !current.Mode().IsRegular() {
		return errors.New("export destination became a non-regular file while writing")
	}
	if !d.exists || !os.SameFile(d.info, current) {
		return errors.New("export destination changed while writing")
	}
	return nil
}
