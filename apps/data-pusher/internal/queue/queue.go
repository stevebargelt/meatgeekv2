// Package queue implements a disk-backed FIFO message queue for the data-pusher's
// outbound IoT Hub publish path. It is the sole writer to the IoT Hub client per
// the architect's all-through-queue model: collector producers Enqueue opaque
// payloads, and the publisher consumer drains them via Peek/Ack.
//
// On-disk layout: append-only segment files (seg-<firstID>.dat) sized for ARM64
// Pi flash, plus a small meta.json holding the next-id, head-id, and a
// persisted monotonic sequence counter used by callers to mint deterministic
// IoT Hub message IDs across restarts.
package queue

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

const (
	defaultMaxBytes        = int64(100 * 1024 * 1024) // 100 MB
	defaultFlushInterval   = 2 * time.Second
	defaultFlushEveryN     = 64
	defaultMaxSegmentBytes = int64(4 * 1024 * 1024) // 4 MB
	metaFile               = "meta.json"
	metaTempFile           = "meta.json.tmp"
)

// ErrClosed is returned by operations on a closed queue.
var ErrClosed = errors.New("queue: closed")

// Options controls queue behavior. Zero values get reasonable defaults.
type Options struct {
	// MaxBytes is the soft cap on total bytes across all segment files.
	// When exceeded, oldest segments are dropped and a warning is logged.
	MaxBytes int64

	// FlushInterval is the time between background fsync attempts.
	FlushInterval time.Duration

	// FlushEveryN forces an fsync after this many enqueues since the last sync.
	FlushEveryN int

	// MaxSegmentBytes is the soft cap for a single segment file. Reaching the
	// cap rotates to a new segment on the next enqueue.
	MaxSegmentBytes int64

	// Logger receives eviction warnings and internal errors. Defaults to a
	// fresh logrus.Logger if nil.
	Logger *logrus.Logger
}

func (o Options) withDefaults() Options {
	if o.MaxBytes <= 0 {
		o.MaxBytes = defaultMaxBytes
	}
	if o.FlushInterval <= 0 {
		o.FlushInterval = defaultFlushInterval
	}
	if o.FlushEveryN <= 0 {
		o.FlushEveryN = defaultFlushEveryN
	}
	if o.MaxSegmentBytes <= 0 {
		o.MaxSegmentBytes = defaultMaxSegmentBytes
	}
	if o.Logger == nil {
		o.Logger = logrus.New()
	}
	return o
}

// metaState is the JSON document persisted as meta.json.
type metaState struct {
	NextID     uint64 `json:"nextId"`
	HeadID     uint64 `json:"headId"`
	SeqCounter uint64 `json:"seqCounter"`
}

// Queue is a disk-backed FIFO message queue. Safe for concurrent use.
type Queue struct {
	dir  string
	opts Options

	mu sync.Mutex

	segments  []segment
	writeFile *os.File
	writeBuf  *bufio.Writer

	nextID     uint64 // id to assign to the next Enqueue
	headID     uint64 // id of the next un-Ack'd record (Peek returns this id)
	seqCounter uint64 // monotonic counter returned by NextSeq

	pendingWrites int
	closed        bool
	stopCh        chan struct{}
	flushDone     chan struct{}

	logger *logrus.Logger
}

// Open opens or creates the queue rooted at dir. The directory is created if
// it does not exist. A background goroutine handles time-based fsync until
// Close is called.
func Open(dir string, opts Options) (*Queue, error) {
	o := opts.withDefaults()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("queue: mkdir %s: %w", dir, err)
	}

	q := &Queue{
		dir:       dir,
		opts:      o,
		logger:    o.Logger,
		stopCh:    make(chan struct{}),
		flushDone: make(chan struct{}),
	}

	if err := q.recover(); err != nil {
		return nil, err
	}
	if err := q.openWriteSegment(); err != nil {
		return nil, err
	}

	go q.flushLoop()
	return q, nil
}

// recover reads meta.json and reconciles it with the segments on disk.
// Torn records at the tail of the latest segment are truncated.
func (q *Queue) recover() error {
	if data, err := os.ReadFile(filepath.Join(q.dir, metaFile)); err == nil {
		var m metaState
		if jerr := json.Unmarshal(data, &m); jerr != nil {
			return fmt.Errorf("queue: parse meta: %w", jerr)
		}
		q.nextID = m.NextID
		q.headID = m.HeadID
		q.seqCounter = m.SeqCounter
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("queue: read meta: %w", err)
	}

	if q.nextID == 0 {
		q.nextID = 1
	}
	if q.headID == 0 {
		q.headID = 1
	}

	segs, err := listSegments(q.dir)
	if err != nil {
		return fmt.Errorf("queue: list segments: %w", err)
	}
	q.segments = segs

	// Truncate any torn record at the tail of the latest segment, and bump
	// nextID to one past the highest id we actually see on disk.
	if len(q.segments) > 0 {
		last := &q.segments[len(q.segments)-1]
		lastID, validSize, serr := scanSegment(last.path)
		if serr != nil {
			return fmt.Errorf("queue: scan segment %s: %w", last.path, serr)
		}
		if validSize < last.size {
			if terr := os.Truncate(last.path, validSize); terr != nil {
				return fmt.Errorf("queue: truncate torn segment %s: %w", last.path, terr)
			}
			last.size = validSize
		}
		if lastID >= q.nextID {
			q.nextID = lastID + 1
		}
	}

	// If a prior eviction advanced past records that meta hadn't yet caught up to,
	// pull headID forward to the first surviving segment.
	if len(q.segments) > 0 && q.headID < q.segments[0].firstID {
		q.headID = q.segments[0].firstID
	}
	// Likewise, headID should never exceed nextID.
	if q.headID > q.nextID {
		q.headID = q.nextID
	}

	return nil
}

// openWriteSegment selects (or creates) the segment that subsequent Enqueues append to.
func (q *Queue) openWriteSegment() error {
	if len(q.segments) > 0 {
		last := q.segments[len(q.segments)-1]
		if last.size < q.opts.MaxSegmentBytes {
			f, err := os.OpenFile(last.path, os.O_WRONLY|os.O_APPEND, 0o644)
			if err != nil {
				return fmt.Errorf("queue: open write segment: %w", err)
			}
			q.writeFile = f
			q.writeBuf = bufio.NewWriter(f)
			return nil
		}
	}
	return q.rotateSegmentLocked()
}

// rotateSegmentLocked closes the current write segment and creates a new one
// whose firstID is the current q.nextID. Caller must hold q.mu (or be in Open).
func (q *Queue) rotateSegmentLocked() error {
	if q.writeBuf != nil {
		if err := q.writeBuf.Flush(); err != nil {
			return err
		}
	}
	if q.writeFile != nil {
		if err := q.writeFile.Sync(); err != nil {
			return err
		}
		if err := q.writeFile.Close(); err != nil {
			return err
		}
	}
	firstID := q.nextID
	path := filepath.Join(q.dir, segmentName(firstID))
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("queue: create segment %s: %w", path, err)
	}
	q.writeFile = f
	q.writeBuf = bufio.NewWriter(f)
	q.segments = append(q.segments, segment{firstID: firstID, path: path, size: 0})
	return nil
}

// Enqueue appends payload to the queue. Payload bytes are copied internally
// (via the bufio.Writer), so callers may reuse the slice after return.
func (q *Queue) Enqueue(payload []byte) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrClosed
	}

	if q.segments[len(q.segments)-1].size >= q.opts.MaxSegmentBytes {
		if err := q.rotateSegmentLocked(); err != nil {
			return err
		}
	}

	id := q.nextID
	n, err := writeRecord(q.writeBuf, id, payload)
	if err != nil {
		return fmt.Errorf("queue: write record: %w", err)
	}
	q.nextID++
	q.segments[len(q.segments)-1].size += int64(n)
	q.pendingWrites++

	if q.pendingWrites >= q.opts.FlushEveryN {
		if err := q.flushLocked(); err != nil {
			return err
		}
	}

	if err := q.evictLocked(); err != nil {
		return err
	}
	return nil
}

// Peek returns the head record without removing it. The first return value is
// the record's id, which the caller passes to Ack to confirm receipt.
func (q *Queue) Peek() (uint64, []byte, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return 0, nil, false
	}
	if q.headID >= q.nextID {
		return 0, nil, false
	}

	// Make sure any buffered writes are visible to readers in this process.
	if err := q.flushBufferLocked(); err != nil {
		q.logger.WithError(err).Error("queue: peek buffer flush failed")
		return 0, nil, false
	}

	// Find the segment that contains headID. Segments are sorted by firstID.
	segIdx := -1
	for i := len(q.segments) - 1; i >= 0; i-- {
		if q.segments[i].firstID <= q.headID {
			segIdx = i
			break
		}
	}
	if segIdx < 0 {
		return 0, nil, false
	}
	seg := q.segments[segIdx]

	f, err := os.Open(seg.path)
	if err != nil {
		q.logger.WithError(err).WithField("path", seg.path).Error("queue: peek open segment failed")
		return 0, nil, false
	}
	defer f.Close()

	var offset int64
	for offset < seg.size {
		id, payload, n, rerr := readRecordAt(f, offset)
		if rerr != nil {
			return 0, nil, false
		}
		if id == q.headID {
			return id, payload, true
		}
		offset += int64(n)
	}
	return 0, nil, false
}

// Ack confirms successful processing of the head record and advances the head.
// id must equal the current head id; any other value is rejected.
func (q *Queue) Ack(id uint64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrClosed
	}
	if id != q.headID {
		return fmt.Errorf("queue: ack id=%d does not match current head id=%d", id, q.headID)
	}
	q.headID++
	if err := q.compactLocked(); err != nil {
		return err
	}
	return q.writeMetaLocked()
}

// compactLocked deletes any non-current segments whose records have all been Ack'd.
// The current write segment is never deleted, even if fully drained.
func (q *Queue) compactLocked() error {
	for len(q.segments) > 1 {
		first := q.segments[0]
		next := q.segments[1]
		if next.firstID > q.headID {
			break
		}
		if err := os.Remove(first.path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("queue: remove segment %s: %w", first.path, err)
		}
		q.segments = q.segments[1:]
	}
	return nil
}

// evictLocked drops the oldest segments while the on-disk total exceeds MaxBytes.
// The current write segment is preserved. Un-Ack'd records lost in the drop are
// counted and reported via a single Warn log entry.
func (q *Queue) evictLocked() error {
	total := int64(0)
	for _, s := range q.segments {
		total += s.size
	}
	if total <= q.opts.MaxBytes {
		return nil
	}

	dropped := uint64(0)
	for total > q.opts.MaxBytes && len(q.segments) > 1 {
		first := q.segments[0]
		next := q.segments[1]
		firstUnacked := first.firstID
		if q.headID > firstUnacked {
			firstUnacked = q.headID
		}
		if next.firstID > firstUnacked {
			dropped += next.firstID - firstUnacked
		}
		if err := os.Remove(first.path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("queue: evict segment %s: %w", first.path, err)
		}
		q.segments = q.segments[1:]
		total -= first.size
		if q.headID < next.firstID {
			q.headID = next.firstID
		}
	}

	if dropped > 0 {
		q.logger.WithFields(logrus.Fields{
			"dropped":  dropped,
			"maxBytes": q.opts.MaxBytes,
		}).Warnf("queue: dropped %d messages due to MaxBytes cap", dropped)
	}
	return nil
}

// NextSeq returns and persists the next monotonic sequence number. Used by the
// queue runner to mint deterministic IoT Hub MessageIds whose uniqueness is
// preserved across process restarts.
func (q *Queue) NextSeq() uint64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return 0
	}
	q.seqCounter++
	seq := q.seqCounter
	if err := q.writeMetaLocked(); err != nil {
		q.logger.WithError(err).Error("queue: persist seq counter failed")
	}
	return seq
}

// Close flushes pending writes, fsyncs the segment, persists meta, and stops
// the background flush goroutine. Idempotent.
func (q *Queue) Close() error {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return nil
	}
	q.closed = true
	close(q.stopCh)

	err := q.flushLocked()
	if metaErr := q.writeMetaLocked(); metaErr != nil && err == nil {
		err = metaErr
	}
	if q.writeFile != nil {
		if cerr := q.writeFile.Close(); cerr != nil && err == nil {
			err = cerr
		}
		q.writeFile = nil
	}
	q.mu.Unlock()

	<-q.flushDone
	return err
}

// flushLocked flushes the buffered writer and fsyncs the underlying segment.
// Caller must hold q.mu.
func (q *Queue) flushLocked() error {
	if q.writeBuf != nil {
		if err := q.writeBuf.Flush(); err != nil {
			return err
		}
	}
	if q.writeFile != nil {
		if err := q.writeFile.Sync(); err != nil {
			return err
		}
	}
	q.pendingWrites = 0
	return nil
}

// flushBufferLocked drains the bufio buffer into the OS but does not fsync.
// Used by Peek so reads see records that haven't yet hit disk durably.
func (q *Queue) flushBufferLocked() error {
	if q.writeBuf != nil {
		if err := q.writeBuf.Flush(); err != nil {
			return err
		}
	}
	return nil
}

// writeMetaLocked atomically rewrites meta.json. Caller must hold q.mu.
func (q *Queue) writeMetaLocked() error {
	m := metaState{
		NextID:     q.nextID,
		HeadID:     q.headID,
		SeqCounter: q.seqCounter,
	}
	data, err := json.Marshal(&m)
	if err != nil {
		return err
	}
	tmp := filepath.Join(q.dir, metaTempFile)
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(q.dir, metaFile))
}

// flushLoop runs in a background goroutine, fsyncing pending writes at the
// configured FlushInterval. Stops on Close.
func (q *Queue) flushLoop() {
	defer close(q.flushDone)
	if q.opts.FlushInterval <= 0 {
		return
	}
	t := time.NewTicker(q.opts.FlushInterval)
	defer t.Stop()
	for {
		select {
		case <-q.stopCh:
			return
		case <-t.C:
			q.mu.Lock()
			if !q.closed && q.pendingWrites > 0 {
				if err := q.flushLocked(); err != nil {
					q.logger.WithError(err).Error("queue: background flush failed")
				} else if err := q.writeMetaLocked(); err != nil {
					q.logger.WithError(err).Error("queue: background meta write failed")
				}
			}
			q.mu.Unlock()
		}
	}
}
