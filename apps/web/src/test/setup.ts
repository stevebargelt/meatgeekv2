import { configure } from '@testing-library/react';

/**
 * React Testing Library's findBy* and waitFor poll until their condition holds.
 * Their default 1 s deadline made a correct render that was merely slow (a busy
 * CI runner, a lazily loaded chunk) fail. Here the deadline is a hang guard
 * only, just under Jest's testTimeout (jest.config.ts), so a wait that can
 * never succeed still fails with RTL's own message (the query and the DOM)
 * rather than Jest's generic timeout. No test sets its own `timeout`.
 */
configure({ asyncUtilTimeout: 25_000 });
