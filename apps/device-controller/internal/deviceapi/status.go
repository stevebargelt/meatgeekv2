package deviceapi

import (
	"encoding/json"
	"math"
	"sync"
	"time"
)

// Temps is the five RTD readings, in Fahrenheit. A NaN or Inf reading is
// served as JSON null (see MarshalJSON); an unplugged probe whose reading
// never moved off zero is served as 0.
type Temps struct {
	GrillTemp  float64 `json:"grillTemp"`
	Probe1Temp float64 `json:"probe1Temp"`
	Probe2Temp float64 `json:"probe2Temp"`
	Probe3Temp float64 `json:"probe3Temp"`
	Probe4Temp float64 `json:"probe4Temp"`
}

// Status is the smoker state get_status serves. Its JSON shape is the
// contract the data-pusher parses (apps/data-pusher/internal/wire.V1Status):
// do not change a field or a tag without changing the pusher and the golden
// file libs/api-interfaces/test-vectors/controller-get-status.json.
type Status struct {
	ID          string    `json:"id"`
	TTL         int       `json:"ttl"`
	SmokerID    string    `json:"smokerid"`
	Type        string    `json:"type"`
	AugerOn     bool      `json:"augerOn"`
	BlowerOn    bool      `json:"blowerOn"`
	IgniterOn   bool      `json:"igniterOn"`
	Temps       Temps     `json:"temps"`
	FireHealthy bool      `json:"fireHealthy"`
	Mode        string    `json:"mode"`
	SetPoint    int       `json:"setPoint"`
	ModeTime    time.Time `json:"modeTime"`
	CurrentTime time.Time `json:"currentTime"`
}

// MarshalJSON serves NaN and Inf readings as null, which encoding/json
// cannot encode on its own.
func (t Temps) MarshalJSON() ([]byte, error) {
	type Alias Temps
	temp := struct {
		GrillTemp  interface{} `json:"grillTemp"`
		Probe1Temp interface{} `json:"probe1Temp"`
		Probe2Temp interface{} `json:"probe2Temp"`
		Probe3Temp interface{} `json:"probe3Temp"`
		Probe4Temp interface{} `json:"probe4Temp"`
		Alias
	}{
		Alias: Alias(t),
	}

	temp.GrillTemp = handleNaN(t.GrillTemp)
	temp.Probe1Temp = handleNaN(t.Probe1Temp)
	temp.Probe2Temp = handleNaN(t.Probe2Temp)
	temp.Probe3Temp = handleNaN(t.Probe3Temp)
	temp.Probe4Temp = handleNaN(t.Probe4Temp)

	return json.Marshal(temp)
}

// handleNaN converts NaN and Inf to nil, which serializes as null.
func handleNaN(val float64) interface{} {
	if math.IsNaN(val) || math.IsInf(val, 0) {
		return nil
	}
	return val
}

// StatusSource is where the commands read the smoker state. main passes the
// hardware-backed Store; tests pass fixed temperatures.
type StatusSource interface {
	Status() Status
}

// Store is a StatusSource safe for one writer (the hardware loop) and many
// readers (the HTTP commands).
type Store struct {
	mu sync.RWMutex
	s  Status
}

// NewStore returns a Store holding initial.
func NewStore(initial Status) *Store {
	return &Store{s: initial}
}

// Status returns a copy of the current state.
func (st *Store) Status() Status {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return st.s
}

// Update changes the state under the lock.
func (st *Store) Update(fn func(*Status)) {
	st.mu.Lock()
	defer st.mu.Unlock()
	fn(&st.s)
}
