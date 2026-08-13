//go:build windows

package atomicexport

import "testing"

func TestSyncDirectoryDoesNotRejectPublishedWindowsExport(t *testing.T) {
	if err := syncDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
}
