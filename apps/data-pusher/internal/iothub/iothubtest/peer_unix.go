//go:build linux || darwin || freebsd || netbsd || openbsd

package iothubtest

import (
	"errors"
	"net"
	"syscall"

	"github.com/eclipse/paho.mqtt.golang/packets"
)

// peerOpen reports whether the device still holds nc open, from the kernel's
// receive queue rather than from the broker's reader goroutine (which may not
// have run yet): it peeks one byte without consuming it or blocking. A
// pending close (EOF or reset) or a pending DISCONNECT means the device has
// let go; an empty queue, or any other packet waiting, means it has not.
func peerOpen(nc net.Conn) bool {
	sc, ok := nc.(syscall.Conn)
	if !ok {
		return true
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		return false
	}
	open := false
	err = raw.Control(func(fd uintptr) {
		var b [1]byte
		n, _, rerr := syscall.Recvfrom(int(fd), b[:], syscall.MSG_PEEK|syscall.MSG_DONTWAIT)
		switch {
		case errors.Is(rerr, syscall.EAGAIN) || errors.Is(rerr, syscall.EWOULDBLOCK):
			open = true // connected, nothing pending
		case rerr != nil, n == 0:
			open = false // reset, or EOF: the device closed it
		default:
			open = b[0]>>4 != packets.Disconnect
		}
	})
	if err != nil {
		return false // the broker has closed the socket itself
	}
	return open
}
