/** Shown when config.json has no clientId: the SPA app registration does not exist yet. */
export function NotConfiguredPage() {
  return (
    <main className="status-page">
      <h1>Sign-in is not configured yet</h1>
      <p>
        This deployment has no Entra app registration for the web app, so nobody can sign in. Once
        the registration exists, its client ID goes in <code>config.json</code> and this page goes
        away.
      </p>
    </main>
  );
}

/** Shown when config.json is missing, unreadable, or the wrong shape. */
export function ConfigErrorPage({ problems }: { problems: string[] }) {
  return (
    <main className="status-page">
      <h1>The app could not load its configuration</h1>
      <p>
        <code>/config.json</code> has a problem:
      </p>
      <ul>
        {problems.map(problem => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </main>
  );
}
