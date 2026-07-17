package goqueue_test

import (
	"runtime"
	"sync"

	queue "github.com/stevebargelt/meatgeekv2/apps/device-controller/goqueue"
)

var _ = Describe("Queue", func() {

	runtime.GOMAXPROCS(runtime.NumCPU())

	Describe("Call the New function", func() {
		Context("With a fixed size", func() {
			q := queue.New(10)
			It("Should return a pointer to a new Queue of that size", func() {
				Expect(q).ToNot(BeNil())
				Expect(q.Cap()).To(Equal(int64(10)))
			})
		})

		Context("With non size", func() {
			q := queue.New()
			It("Should return a pointer to a new Queue of unlimited size", func() {
				Expect(q).ToNot(BeNil())
				Expect(q.Cap()).To(Equal(int64(-1)))
			})
		})
	})

	Describe("Len method", func() {
		Describe("Should return the current Queue length", func() {
			Context("With ten elements", func() {
				q := queue.New()
				for i := 0; i < 10; i++ {
					q.Push(struct{}{})
				}
				It("Should return ten", func() {
					Expect(q.Len()).To(Equal(int64(10)))
				})
			})

			Context("With no elements", func() {
				q := queue.New()
				It("Should return zero", func() {
					Expect(q.Len()).To(BeZero())
				})
			})
		})
	})

	Describe("Push method", func() {
		Context("Push a new element at the end of the queue", func() {
			q := queue.New()
			q.Push(true)
			It("Should be a queue of unlimited capacity with one true element", func() {
				Expect(q.Cap()).To(Equal(int64(-1)))
				Expect(q.Len()).To(Equal(int64(1)))
				Expect(q.Pop()).To(BeTrue())
				Expect(q.Pop()).To(BeNil())
			})
		})

		Context("Push two elements at the end of the queue is FIFO", func() {
			q := queue.New()
			q.Push(true)
			q.Push(false)
			It("Should be an unlimited queue with two elements, first one true", func() {
				Expect(q.Cap()).To(Equal(int64(-1)))
				Expect(q.Len()).To(Equal(int64(2)))
				Expect(q.Pop()).To(BeTrue())
				Expect(q.Len()).To(Equal(int64(1)))
			})
		})

		Context("Push beyond size pops the top of queue", func() {
			q := queue.New(3)
			q.Push(1)
			q.Push(2)
			q.Push(3)
			q.Push(4)
			It("Should return the second element (FIFO)", func() {
				Expect(q.Pop()).To(Equal(int(2)))
			})
		})
	})

	Describe("Thread Safety", func() {
		Context("Push is thread safe with two or more goroutines", func() {
			q := queue.New()
			// Launch six concurrent pushes and wait for every one to complete
			// before asserting length; a WaitGroup gives deterministic
			// synchronization without sleeps.
			var wg sync.WaitGroup
			wg.Add(6)
			for i := 0; i < 6; i++ {
				go func(q *queue.Queue) {
					defer wg.Done()
					q.Push(1)
				}(q)
			}
			wg.Wait()
			It("Should be a queue of six elements", func() {
				Expect(q.Len()).To(Equal(int64(6)))
			})
		})

		Context("Calling push and pop in goroutines is safe", func() {
			q := queue.New()
			// Prefill 300 items so that every one of the 300 concurrent Pop
			// workers is guaranteed an element to remove, regardless of how
			// the Push and Pop goroutines interleave (worst case: all pops
			// run before any push, and the prefill still covers them).
			for i := 0; i < 300; i++ {
				q.Push(1)
			}

			// Concurrently run 300 pushes and 300 pops — genuinely
			// contended access — and wait for all 600 to finish before
			// asserting. Final length is deterministic: 300 prefill +
			// 300 pushed - 300 popped = 300.
			var wg sync.WaitGroup
			wg.Add(600)
			for i := 0; i < 300; i++ {
				go func(q *queue.Queue) {
					defer wg.Done()
					q.Push(1)
				}(q)
			}
			for i := 0; i < 300; i++ {
				go func(q *queue.Queue) {
					defer wg.Done()
					q.Pop()
				}(q)
			}
			wg.Wait()

			It("Should be a Queue of three hundred elements", func() {
				Expect(q.Len()).To(Equal(int64(300)))
			})
		})
	})

	Describe("Values returns the whole Queue values", func() {
		q := queue.New()
		for i := 1; i < 6; i++ {
			q.Push(i * i)
		}
		It("Shouldn't mute the Queue", func() {
			v := q.Values()
			Expect(v).To(Equal([]interface{}{1, 4, 9, 16, 25}))
			Expect(q.Len()).To(Equal(int64(5)))
		})

		Context("If the Queue is empty", func() {
			q := queue.New()
			It("Returns just empty slice", func() {
				v := q.Values()
				Expect(v).To(Equal([]interface{}{}))
			})
		})
	})

})
