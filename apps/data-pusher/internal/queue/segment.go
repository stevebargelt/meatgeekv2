package queue

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	segmentPrefix    = "seg-"
	segmentSuffix    = ".dat"
	recordHeaderSize = 12 // 8-byte big-endian id + 4-byte big-endian length
)

// segment describes one append-only on-disk segment file.
type segment struct {
	firstID uint64
	path    string
	size    int64
}

// segmentName produces the canonical filename for a segment that begins at firstID.
// Zero-padded so lexical sort matches numeric sort.
func segmentName(firstID uint64) string {
	return fmt.Sprintf("%s%020d%s", segmentPrefix, firstID, segmentSuffix)
}

// parseSegmentName extracts the firstID from a segment filename. Returns ok=false
// for any filename that doesn't match the pattern.
func parseSegmentName(name string) (uint64, bool) {
	if !strings.HasPrefix(name, segmentPrefix) || !strings.HasSuffix(name, segmentSuffix) {
		return 0, false
	}
	idStr := name[len(segmentPrefix) : len(name)-len(segmentSuffix)]
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}

// listSegments returns all segment files in dir, sorted by firstID ascending.
// Files that don't match the segment naming pattern are ignored.
func listSegments(dir string) ([]segment, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var segs []segment
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		firstID, ok := parseSegmentName(e.Name())
		if !ok {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		segs = append(segs, segment{
			firstID: firstID,
			path:    filepath.Join(dir, e.Name()),
			size:    info.Size(),
		})
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].firstID < segs[j].firstID })
	return segs, nil
}

// writeRecord appends a record to w. Returns the number of bytes written
// (header + payload), or an error on short/failed write.
func writeRecord(w *bufio.Writer, id uint64, payload []byte) (int, error) {
	var header [recordHeaderSize]byte
	binary.BigEndian.PutUint64(header[0:8], id)
	binary.BigEndian.PutUint32(header[8:12], uint32(len(payload)))
	if _, err := w.Write(header[:]); err != nil {
		return 0, err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return recordHeaderSize, err
		}
	}
	return recordHeaderSize + len(payload), nil
}

// readRecordAt reads one record from f at the given byte offset. Returns
// (id, payload, bytesConsumed, err). On torn-record / EOF, returns io.EOF.
func readRecordAt(f *os.File, offset int64) (uint64, []byte, int, error) {
	var header [recordHeaderSize]byte
	n, err := f.ReadAt(header[:], offset)
	if err != nil {
		if err == io.EOF && n == 0 {
			return 0, nil, 0, io.EOF
		}
		// Partial header — treat as torn record.
		return 0, nil, 0, io.EOF
	}
	id := binary.BigEndian.Uint64(header[0:8])
	length := binary.BigEndian.Uint32(header[8:12])
	payload := make([]byte, length)
	if length > 0 {
		if _, rerr := f.ReadAt(payload, offset+int64(recordHeaderSize)); rerr != nil {
			// Torn payload.
			return 0, nil, 0, io.EOF
		}
	}
	return id, payload, recordHeaderSize + int(length), nil
}

// scanSegment walks the segment from offset 0, returning the id of the last
// fully-readable record and the byte offset where that record ends. A torn
// record at the tail is silently treated as end-of-segment so recovery can
// truncate the file back to a record boundary.
func scanSegment(path string) (lastID uint64, validSize int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, 0, err
	}
	total := info.Size()
	var offset int64
	for offset < total {
		id, _, n, rerr := readRecordAt(f, offset)
		if rerr != nil {
			// Stop at the first torn record — its bytes will be truncated by caller.
			return lastID, offset, nil
		}
		lastID = id
		offset += int64(n)
	}
	return lastID, offset, nil
}
