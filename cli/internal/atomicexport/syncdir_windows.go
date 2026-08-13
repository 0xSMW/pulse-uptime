//go:build windows

package atomicexport

// Windows does not provide a portable directory-handle flush through os.File.
// The staged file itself is synced before publication, so avoid turning a
// successful export into a false failure after it becomes visible.
func syncDirectory(string) error {
	return nil
}
