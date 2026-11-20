import type { ApiProblem } from './problem';

/** An error line with the server's message and, when known, its request id. */
export function ProblemMessage({ problem }: { problem: ApiProblem }) {
  return (
    <div className="problem" role="alert">
      <span>{problem.message}</span>
      {problem.requestId && (
        <span className="request-id">
          {' '}
          Request ID: <code>{problem.requestId}</code>
        </span>
      )}
    </div>
  );
}
