//go:build !(linux || darwin || freebsd || netbsd || openbsd)

package iothubtest

import "net"

// peerOpen cannot peek the kernel's receive queue on this platform, so it
// treats every connection the broker has not finished with as open.
func peerOpen(net.Conn) bool { return true }
