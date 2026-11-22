package fixture

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestEventually(t *testing.T) {
	assert.Eventually(t, func() bool { return ready }, time.Second, 10*time.Millisecond) // expect: go-eventually
	assert.Never(t, func() bool { return fired }, time.Second, 10*time.Millisecond)      // expect: go-eventually
	Eventually(func() bool { return ready }).Should(BeTrue())                            // expect: go-eventually
	Consistently(func() bool { return ready }).Should(BeTrue())                          // expect: go-eventually
	await.Until(t, "ready", func() bool { return ready })                                // the deadline is the test's own: not a hit
}
