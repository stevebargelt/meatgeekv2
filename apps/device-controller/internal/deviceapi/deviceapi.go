// Package deviceapi is the device-controller's HTTP surface: the gobot robot
// with its get_status and get_temps commands, the gobot API that serves them,
// and the middleware that keeps that API answering.
//
// It is out of main so the real HTTP surface runs in tests without hardware
// (HAR-148). main builds the robot with the hardware connections, devices and
// work loop; tests build it with none and a fixed StatusSource.
//
// Two gobot v2.5.0 behaviours this package works around:
//
//   - executeCommand does json.NewDecoder(req.Body).Decode(&body) and panics on
//     any error. A GET with no body (what the data-pusher sends) decodes to
//     EOF, so every poll panicked and net/http dropped the connection.
//     DefaultCommandBody supplies "{}" as the body when the request has none.
//   - gobot's middleware (API.AddHandler) runs before routing, one handler
//     after another; it cannot wrap the router, so it cannot recover a panic.
//     Recover wraps the whole API as a plain http.Handler instead.
package deviceapi

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"

	"go.opentelemetry.io/otel/trace"
	"gobot.io/x/gobot/v2"
	"gobot.io/x/gobot/v2/api"

	"github.com/stevebargelt/meatgeekv2/apps/device-controller/internal/httptrace"
)

const (
	// RobotName is the robot segment of every command route.
	RobotName = "MeatGeekBot"
	// Port is the port the API listens on. The data-pusher polls
	// http://localhost:3000.
	Port = "3000"

	commandPathPrefix = "/api/robots/"
)

// NewRobot builds the MeatGeekBot robot with the get_status and get_temps
// commands, both reading src. connections, devices and work are the hardware
// (nil in tests).
func NewRobot(src StatusSource, connections []gobot.Connection, devices []gobot.Device, work func()) *gobot.Robot {
	robot := gobot.NewRobot(RobotName, connections, devices, work)

	robot.AddCommand("get_temps", func(map[string]interface{}) interface{} {
		res, err := json.Marshal(src.Status().Temps)
		if err != nil {
			log.Printf("get_temps: %v", err)
		}
		return string(res)
	})

	robot.AddCommand("get_status", func(map[string]interface{}) interface{} {
		res, err := json.Marshal(src.Status())
		if err != nil {
			log.Printf("get_status: %v", err)
		}
		return string(res)
	})

	return robot
}

// Config is the optional wiring for NewHandler.
type Config struct {
	// Tracer, when set, continues the data-pusher's W3C trace on each request.
	Tracer trace.Tracer
	// Debug logs every request line (gobot's API.Debug).
	Debug bool
}

// NewHandler builds the gobot API over manager, with gobot's standard routes
// (the C3PIO API and the Robeaux UI, the same routes API.Start registers) and
// this package's middleware, and returns it wrapped in Recover. Serve it on
// Port.
func NewHandler(manager *gobot.Manager, cfg Config) http.Handler {
	a := api.NewAPI(manager)
	a.Port = Port
	if cfg.Tracer != nil {
		a.AddHandler(httptrace.Middleware(cfg.Tracer))
	}
	a.AddHandler(DefaultCommandBody)
	if cfg.Debug {
		a.Debug()
	}
	a.AddRobeauxRoutes()
	return Recover(a)
}

// DefaultCommandBody is gobot API middleware (API.AddHandler). For a request
// under /api/robots/ that carries no body, it supplies "{}" so gobot's
// executeCommand decodes an empty parameter map instead of panicking on EOF.
// A request with a body is left alone. gobot passes the live *http.Request to
// each middleware and then to the router, so replacing Body here is what the
// command handler reads.
func DefaultCommandBody(_ http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, commandPathPrefix) {
		return
	}
	if r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0 {
		r.Body = io.NopCloser(strings.NewReader("{}"))
		r.ContentLength = 2
	}
}

// Recover answers 500 with a small JSON error when next panics, instead of
// letting net/http drop the connection. It logs one line with the method, the
// path and the panic value; never the request body. http.ErrAbortHandler is
// re-panicked: it is net/http's own signal to abort the response.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rw := &trackingWriter{ResponseWriter: w}
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			log.Printf("deviceapi: recovered panic serving %s %s: %v", r.Method, r.URL.Path, v)
			if rw.wrote {
				// Too late to change the status; end the response here.
				return
			}
			rw.Header().Set("Content-Type", "application/json; charset=utf-8")
			rw.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(rw, `{"error":"internal error"}`)
		}()
		next.ServeHTTP(rw, r)
	})
}

// trackingWriter records whether the response has started, so Recover knows
// whether it can still send a 500.
type trackingWriter struct {
	http.ResponseWriter
	wrote bool
}

func (t *trackingWriter) WriteHeader(code int) {
	t.wrote = true
	t.ResponseWriter.WriteHeader(code)
}

func (t *trackingWriter) Write(b []byte) (int, error) {
	t.wrote = true
	return t.ResponseWriter.Write(b)
}

// Flush keeps gobot's event-stream route working through the wrapper.
func (t *trackingWriter) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
