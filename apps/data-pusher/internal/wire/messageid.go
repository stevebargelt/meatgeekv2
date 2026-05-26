package wire

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"
)

// MintMessageId produces a deterministic IoT Hub message id for a
// (deviceId, timestamp, seq) triple. The id is deterministic for
// identical inputs so a sink-side upsert can dedupe replays (the queue
// runner can re-enqueue and re-publish a payload after a process crash
// without producing a second logical message at the sink).
//
// Why deterministic-with-seq and not a UUID: the brief's "IoT Hub
// deduplicates" claim is incorrect — IoT Hub does not dedupe by
// messageId. The dedupe lives in the sink (CosmosDB upsert keyed on
// messageId), so the id MUST be stable across retries of the *same*
// logical payload but distinct across legitimately distinct payloads
// that share a (deviceId, timestamp). The seq is supplied by the
// queue's persisted monotonic counter (step 2), so identical
// (deviceId, ts) tuples emitted as separate readings still get unique
// ids.
//
// Format: 64-char hex SHA-256 of "<deviceId>|<unix-nanos>|<seq>". Hex
// (not base64) for easy log-grepping and because IoT Hub message-id
// validation rejects '+' and '/'.
func MintMessageId(deviceID string, ts time.Time, seq uint64) string {
	h := sha256.New()
	h.Write([]byte(deviceID))
	h.Write([]byte{'|'})
	h.Write([]byte(strconv.FormatInt(ts.UTC().UnixNano(), 10)))
	h.Write([]byte{'|'})
	h.Write([]byte(strconv.FormatUint(seq, 10)))
	return hex.EncodeToString(h.Sum(nil))
}
