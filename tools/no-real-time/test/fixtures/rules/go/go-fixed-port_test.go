package fixture

import (
	"net"
	"net/http"
	"testing"
)

func TestFixedPort(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:8080") // expect: go-fixed-port
	_ = ln
	_ = http.ListenAndServe(":9090", nil) // expect: go-fixed-port
	tcp, _ := net.ListenTCP("tcp", &net.TCPAddr{Port: 4300}) // expect: go-fixed-port
	_ = tcp
	free, _ := net.Listen("tcp", "127.0.0.1:0") // port 0: not a hit
	_ = free
}
