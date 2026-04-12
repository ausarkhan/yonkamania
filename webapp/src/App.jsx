const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

function App() {
  return (
    <main className="app-shell">
      <section className="card">
        <p className="eyebrow">Monorepo ready</p>
        <h1>Yonkamania</h1>
        <p>
          The backend is isolated in <code>backend/</code> for Railway deployment and the
          React frontend lives in <code>webapp/</code> for later Vercel or Netlify hosting.
        </p>

        <div className="stack">
          <span>Backend API:</span>
          <code>{apiUrl}</code>
        </div>
      </section>
    </main>
  );
}

export default App;
