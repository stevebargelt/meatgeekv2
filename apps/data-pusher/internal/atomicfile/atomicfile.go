// Package atomicfile writes a file so that a crash never leaves half of it:
// the bytes go to a temporary file in the same directory, are synced, and only
// then take the target's name.
package atomicfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Write replaces path with data, with mode perm, atomically.
func Write(path string, data []byte, perm os.FileMode) error {
	tmp, err := writeTemp(path, data, perm)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("atomicfile: rename to %s: %w", path, err)
	}
	return syncDir(filepath.Dir(path))
}

// WriteNew creates path with data, with mode perm, atomically, and never
// replaces an existing file: when path already exists it returns an error
// that matches os.ErrExist and leaves the existing file as it was. Two
// processes racing to create the same file both see one winner's bytes.
func WriteNew(path string, data []byte, perm os.FileMode) error {
	tmp, err := writeTemp(path, data, perm)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	// link(2) fails with EEXIST instead of replacing, unlike rename(2).
	if err := os.Link(tmp, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("atomicfile: %s: %w", path, os.ErrExist)
		}
		return fmt.Errorf("atomicfile: link to %s: %w", path, err)
	}
	return syncDir(filepath.Dir(path))
}

// writeTemp writes data to a new temporary file next to path, with mode perm,
// synced to disk, and returns its name.
func writeTemp(path string, data []byte, perm os.FileMode) (string, error) {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return "", fmt.Errorf("atomicfile: create temp in %s: %w", dir, err)
	}
	name := f.Name()
	fail := func(step string, err error) (string, error) {
		_ = f.Close()
		_ = os.Remove(name)
		return "", fmt.Errorf("atomicfile: %s %s: %w", step, name, err)
	}
	// CreateTemp makes the file 0600; Chmod (unlike the create) is not
	// narrowed by the umask, so the target gets exactly perm.
	if err := f.Chmod(perm); err != nil {
		return fail("chmod", err)
	}
	if _, err := f.Write(data); err != nil {
		return fail("write", err)
	}
	if err := f.Sync(); err != nil {
		return fail("fsync", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(name)
		return "", fmt.Errorf("atomicfile: close %s: %w", name, err)
	}
	return name, nil
}

// syncDir makes the new directory entry durable.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("atomicfile: open dir %s: %w", dir, err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("atomicfile: fsync dir %s: %w", dir, err)
	}
	return nil
}
