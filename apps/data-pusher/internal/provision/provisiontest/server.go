// Package provisiontest is a fake Azure IoT Hub Device Provisioning Service
// for tests: an HTTPS server on 127.0.0.1 that requires a client certificate,
// as DPS does for an X.509 enrollment, and answers the device registration API
// that internal/provision speaks. Each registration is first "assigning"
// (with Retry-After: 3) and then assigned to the next hub in the list given to
// NewServer.
//
// The server is an await.Source: it signals after every request it handles.
package provisiontest

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
)

// RetryAfter is the Retry-After, in seconds, the fake sends while assigning.
const RetryAfter = 3

// Request is one request the fake received.
type Request struct {
	Method   string
	Path     string
	RawQuery string
	Body     []byte
	ClientCN string // the client certificate's subject CN
}

// Server is the fake DPS. All methods are safe for concurrent use.
type Server struct {
	srv  *httptest.Server
	sig  await.Signal
	hubs []string

	mu            sync.Mutex
	requests      []Request
	registrations int
	refuse        int // HTTP status to refuse registrations with, 0 none
}

// NewServer starts a fake DPS that assigns the n-th registration (1-based) to
// hubs[n-1], or the last hub once the list runs out. It stops when the test
// ends.
func NewServer(t testing.TB, hubs ...string) *Server {
	t.Helper()
	if len(hubs) == 0 {
		t.Fatal("provisiontest: NewServer needs at least one hub")
	}
	s := &Server{hubs: hubs}
	s.srv = httptest.NewUnstartedServer(http.HandlerFunc(s.serve))
	s.srv.TLS = &tls.Config{ClientAuth: tls.RequireAnyClientCert}
	s.srv.StartTLS()
	t.Cleanup(s.srv.Close)
	return s
}

// Endpoint is the host:port to pass as the DPS endpoint.
func (s *Server) Endpoint() string { return s.srv.Listener.Addr().String() }

// RootCAs trusts the fake's server certificate (provision.WithRootCAs).
func (s *Server) RootCAs() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(s.srv.Certificate())
	return pool
}

// Changed implements await.Source.
func (s *Server) Changed() <-chan struct{} { return s.sig.Changed() }

// Registrations is how many registration PUTs the fake has received.
func (s *Server) Registrations() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.registrations
}

// Requests is every request received, in order.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}

// Refuse makes every later registration PUT fail with HTTP status (401 or
// 403, as DPS answers a certificate it has no enrollment for); 0 stops it.
func (s *Server) Refuse(status int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refuse = status
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	defer s.sig.Notify()
	body, _ := io.ReadAll(r.Body)
	cn := ""
	if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
		cn = r.TLS.PeerCertificates[0].Subject.CommonName
	}
	s.mu.Lock()
	s.requests = append(s.requests, Request{Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery, Body: body, ClientCN: cn})
	refuse := s.refuse
	s.mu.Unlock()

	// /<idScope>/registrations/<id>/register or .../operations/<opId>
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	switch {
	case r.Method == http.MethodPut && len(parts) == 4 && parts[1] == "registrations" && parts[3] == "register":
		if refuse != 0 {
			w.WriteHeader(refuse)
			_, _ = io.WriteString(w, `{"errorCode":401002,"message":"refused by the fake"}`)
			return
		}
		s.mu.Lock()
		s.registrations++
		n := s.registrations
		s.mu.Unlock()
		w.Header().Set("Retry-After", fmt.Sprint(RetryAfter))
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"operationId": fmt.Sprintf("op-%d", n), "status": "assigning"})
	case r.Method == http.MethodGet && len(parts) == 5 && parts[1] == "registrations" && parts[3] == "operations":
		var n int
		if _, err := fmt.Sscanf(parts[4], "op-%d", &n); err != nil || n < 1 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		hub := s.hubs[min(n, len(s.hubs))-1]
		_ = json.NewEncoder(w).Encode(map[string]any{
			"operationId": parts[4],
			"status":      "assigned",
			"registrationState": map[string]any{
				"registrationId": parts[2],
				"assignedHub":    hub,
				"deviceId":       parts[2],
				"status":         "assigned",
			},
		})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}
