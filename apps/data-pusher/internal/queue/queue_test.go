package queue

import (
	"bytes"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// drainAll calls Peek/Ack in a loop until empty, returning the payloads in
// the order observed. ackedSeen tallies ids by visit-count for exactly-once
// assertions.
func drainAll(t *testing.T, q *Queue) [][]byte {
	t.Helper()
	var out [][]byte
	for {
		id, payload, ok := q.Peek()
		if !ok {
			return out
		}
		cp := make([]byte, len(payload))
		copy(cp, payload)
		out = append(out, cp)
		if err := q.Ack(id); err != nil {
			t.Fatalf("Ack(%d): %v", id, err)
		}
	}
}

// quietLogger returns a logger whose output is discarded; some tests want
// to capture the logger, which they do explicitly.
func quietLogger() *logrus.Logger {
	l := logrus.New()
	l.SetOutput(&bytes.Buffer{})
	l.SetLevel(logrus.WarnLevel)
	return l
}

func TestQueueEnqueuePeekAckRoundTrip(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, Options{Logger: quietLogger()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer q.Close()

	payloads := [][]byte{
		[]byte("first"),
		[]byte("second"),
		[]byte("third with embedded \x00 nulls"),
		make([]byte, 0), // empty payload
	}
	for i, p := range payloads {
		if err := q.Enqueue(p); err != nil {
			t.Fatalf("Enqueue[%d]: %v", i, err)
		}
	}

	got := drainAll(t, q)
	if len(got) != len(payloads) {
		t.Fatalf("expected %d payloads, got %d", len(payloads), len(got))
	}
	for i, want := range payloads {
		if !bytes.Equal(got[i], want) {
			t.Errorf("payload[%d]: got %q, want %q", i, got[i], want)
		}
	}

	// Now empty.
	if _, _, ok := q.Peek(); ok {
		t.Error("expected Peek to return ok=false after draining")
	}
}

func TestQueueConcurrentEnqueueExactlyOnce(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, Options{
		Logger:        quietLogger(),
		FlushInterval: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer q.Close()

	const goroutines = 8
	const perG = 64
	const total = goroutines * perG

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				payload := []byte(fmt.Sprintf("g=%d i=%d", g, i))
				if err := q.Enqueue(payload); err != nil {
					t.Errorf("Enqueue: %v", err)
					return
				}
			}
		}(g)
	}
	wg.Wait()

	got := drainAll(t, q)
	if len(got) != total {
		t.Fatalf("expected %d drained, got %d", total, len(got))
	}

	// Build the expected multiset of payloads and assert each appears
	// exactly once.
	wantSet := make(map[string]int, total)
	for g := 0; g < goroutines; g++ {
		for i := 0; i < perG; i++ {
			wantSet[fmt.Sprintf("g=%d i=%d", g, i)]++
		}
	}
	for _, p := range got {
		wantSet[string(p)]--
	}
	for k, v := range wantSet {
		if v != 0 {
			t.Errorf("payload %q delta=%d (want 0 — exactly-once)", k, v)
		}
	}
}

// recordingLogger captures Warn-level entries so the eviction test can assert
// the warning fires.
type recordingHook struct {
	mu      sync.Mutex
	entries []*logrus.Entry
}

func (h *recordingHook) Levels() []logrus.Level {
	return []logrus.Level{logrus.WarnLevel, logrus.ErrorLevel}
}

func (h *recordingHook) Fire(e *logrus.Entry) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	// Copy the entry; logrus reuses the underlying struct.
	cp := *e
	h.entries = append(h.entries, &cp)
	return nil
}

func (h *recordingHook) Warnings() []*logrus.Entry {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]*logrus.Entry, 0, len(h.entries))
	for _, e := range h.entries {
		if e.Level == logrus.WarnLevel {
			out = append(out, e)
		}
	}
	return out
}

func TestQueueMaxBytesDropsOldestAndWarns(t *testing.T) {
	dir := t.TempDir()
	hook := &recordingHook{}
	logger := logrus.New()
	logger.SetOutput(&bytes.Buffer{})
	logger.AddHook(hook)

	// Very small segments + cap so a handful of writes triggers eviction.
	q, err := Open(dir, Options{
		MaxBytes:        256,
		MaxSegmentBytes: 64,
		FlushEveryN:     1,
		FlushInterval:   50 * time.Millisecond,
		Logger:          logger,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer q.Close()

	// Each record is 12-byte header + 32-byte payload = 44 bytes; one record
	// per segment given a 64-byte segment cap. Twenty records => 880 bytes
	// which is well over the 256-byte cap, forcing repeated drop-oldest.
	payload := bytes.Repeat([]byte("x"), 32)
	for i := 0; i < 20; i++ {
		if err := q.Enqueue(payload); err != nil {
			t.Fatalf("Enqueue[%d]: %v", i, err)
		}
	}

	warnings := hook.Warnings()
	if len(warnings) == 0 {
		t.Fatal("expected at least one Warn-level eviction log")
	}
	totalDropped := uint64(0)
	for _, w := range warnings {
		if v, ok := w.Data["dropped"].(uint64); ok {
			totalDropped += v
		}
	}
	if totalDropped == 0 {
		t.Errorf("expected eviction warnings to report a non-zero 'dropped' count, entries=%+v", warnings)
	}

	// Some records survived; we should be able to peek something.
	if _, _, ok := q.Peek(); !ok {
		t.Error("expected at least one record to remain after eviction")
	}
}

func TestQueueRecoversUnAckedAfterReopen(t *testing.T) {
	dir := t.TempDir()
	q1, err := Open(dir, Options{
		Logger:        quietLogger(),
		FlushInterval: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("Open#1: %v", err)
	}

	payloads := [][]byte{
		[]byte("alpha"),
		[]byte("beta"),
		[]byte("gamma"),
		[]byte("delta"),
	}
	for _, p := range payloads {
		if err := q1.Enqueue(p); err != nil {
			t.Fatalf("Enqueue: %v", err)
		}
	}

	// Burn a seq number so the second Open observes a non-zero counter.
	seq1 := q1.NextSeq()
	if seq1 == 0 {
		t.Fatal("expected first NextSeq > 0")
	}

	// Ack only the first record. Three are still un-Ack'd.
	id, _, ok := q1.Peek()
	if !ok {
		t.Fatal("expected Peek to succeed before close")
	}
	if err := q1.Ack(id); err != nil {
		t.Fatalf("Ack: %v", err)
	}

	if err := q1.Close(); err != nil {
		t.Fatalf("Close#1: %v", err)
	}

	q2, err := Open(dir, Options{Logger: quietLogger()})
	if err != nil {
		t.Fatalf("Open#2: %v", err)
	}
	defer q2.Close()

	got := drainAll(t, q2)
	wantTail := payloads[1:]
	if len(got) != len(wantTail) {
		t.Fatalf("expected %d recovered records, got %d", len(wantTail), len(got))
	}
	for i, want := range wantTail {
		if !bytes.Equal(got[i], want) {
			t.Errorf("recovered[%d]: got %q, want %q", i, got[i], want)
		}
	}

	// Sequence counter must resume strictly above seq1 — never reuse a value.
	seq2 := q2.NextSeq()
	if seq2 <= seq1 {
		t.Errorf("NextSeq after reopen = %d, want > %d (no monotonic overlap)", seq2, seq1)
	}
}

func TestQueueBatchedFsyncSurvivesCleanShutdown(t *testing.T) {
	dir := t.TempDir()

	// FlushEveryN is set high (1000) and FlushInterval is set long (1h) so
	// no automatic fsync fires during the test. Only Close()'s drain can
	// commit these writes — exactly the clean-shutdown path under test.
	q, err := Open(dir, Options{
		Logger:        quietLogger(),
		FlushEveryN:   1000,
		FlushInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	const n = 50
	for i := 0; i < n; i++ {
		if err := q.Enqueue([]byte(fmt.Sprintf("rec-%03d", i))); err != nil {
			t.Fatalf("Enqueue[%d]: %v", i, err)
		}
	}

	// Clean shutdown should drain everything to disk.
	if err := q.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	q2, err := Open(dir, Options{Logger: quietLogger()})
	if err != nil {
		t.Fatalf("Open#2: %v", err)
	}
	defer q2.Close()

	got := drainAll(t, q2)
	if len(got) != n {
		t.Fatalf("expected %d records after Close+Open, got %d", n, len(got))
	}
	for i, p := range got {
		want := fmt.Sprintf("rec-%03d", i)
		if string(p) != want {
			t.Errorf("rec[%d]: got %q, want %q", i, p, want)
		}
	}
}

// TestQueueSegmentRotation exercises the boundary where a single segment
// rolls over to a new one mid-FIFO. Verifies parseSegmentName ordering
// and that compaction of fully-Ack'd older segments works.
func TestQueueSegmentRotationAndCompaction(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, Options{
		Logger:          quietLogger(),
		MaxBytes:        10 * 1024 * 1024, // generous; no eviction in this test
		MaxSegmentBytes: 96,               // forces rotation every ~2 records of 32 bytes
		FlushEveryN:     4,
		FlushInterval:   50 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer q.Close()

	payload := bytes.Repeat([]byte("y"), 32)
	const n = 12
	for i := 0; i < n; i++ {
		if err := q.Enqueue(payload); err != nil {
			t.Fatalf("Enqueue[%d]: %v", i, err)
		}
	}

	got := drainAll(t, q)
	if len(got) != n {
		t.Fatalf("expected %d, got %d (rotation may have lost records)", n, len(got))
	}
	for i, p := range got {
		if !bytes.Equal(p, payload) {
			t.Errorf("rec[%d]: payload mismatch", i)
		}
	}

	// After full drain, compaction should have left at most one segment
	// (the current write segment is never deleted).
	matches, err := filepath.Glob(filepath.Join(dir, "seg-*.dat"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	sort.Strings(matches)
	if len(matches) > 1 {
		t.Errorf("expected ≤1 segment after full ack, got %d: %v", len(matches), matches)
	}
}

// TestQueueAckRejectsWrongId guards the head-id contract: Ack with anything
// other than the current head must fail without advancing.
func TestQueueAckRejectsWrongId(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, Options{Logger: quietLogger()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer q.Close()

	if err := q.Enqueue([]byte("only")); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	id, _, ok := q.Peek()
	if !ok {
		t.Fatal("Peek: not ok")
	}
	if err := q.Ack(id + 999); err == nil {
		t.Fatal("Ack with wrong id should have errored")
	}
	// Head must still be ackable with the right id.
	if err := q.Ack(id); err != nil {
		t.Fatalf("Ack with correct id: %v", err)
	}
	if _, _, ok := q.Peek(); ok {
		t.Error("Peek should be empty after successful Ack")
	}
}

// TestQueueClosedRejects verifies post-Close operations fail loudly.
func TestQueueClosedRejects(t *testing.T) {
	dir := t.TempDir()
	q, err := Open(dir, Options{Logger: quietLogger()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := q.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := q.Enqueue([]byte("x")); err != ErrClosed {
		t.Errorf("Enqueue after Close: got %v, want ErrClosed", err)
	}
	if _, _, ok := q.Peek(); ok {
		t.Error("Peek after Close should return ok=false")
	}
	if err := q.Ack(1); err != ErrClosed {
		t.Errorf("Ack after Close: got %v, want ErrClosed", err)
	}
	// Close again is a no-op.
	if err := q.Close(); err != nil {
		t.Errorf("Close (idempotent): %v", err)
	}
}
