import React from 'react';
import './app.css';

const App: React.FC = () => {
  return (
    <div className="app">
      <header className="app-header">
        <h1>MeatGeek V2 Web App</h1>
        <p className="app-subtitle">
          Advanced BBQ Temperature Monitoring & Analytics
        </p>
      </header>
      
      <main className="app-main">
        <div className="welcome-section">
          <h2>Welcome to MeatGeek V2</h2>
          <p>
            This is the React web application for the MeatGeek V2 system. 
            This interface provides advanced analytics and desktop-friendly 
            features for your BBQ temperature monitoring.
          </p>
        </div>

        <div className="features-section">
          <h3>Planned Features</h3>
          <div className="features-grid">
            <div className="feature-card">
              <h4>🌡️ Real-time Monitoring</h4>
              <p>Live temperature updates from your BBQ devices</p>
            </div>
            <div className="feature-card">
              <h4>📊 Advanced Analytics</h4>
              <p>Historical data analysis and trend visualization</p>
            </div>
            <div className="feature-card">
              <h4>🔥 Cook Management</h4>
              <p>Comprehensive cook session tracking and notes</p>
            </div>
            <div className="feature-card">
              <h4>📈 Data Export</h4>
              <p>Export cook data in various formats for analysis</p>
            </div>
          </div>
        </div>

        <div className="status-section">
          <h3>Development Status</h3>
          <p>
            This is the initial web app structure created during Phase 0 
            (Monorepo Setup) of the MeatGeek V2 development plan. The full 
            web application will be implemented in Phase 4.
          </p>
        </div>
      </main>

      <footer className="app-footer">
        <p>&copy; 2025 MeatGeek V2 - Cloud-based BBQ monitoring system</p>
      </footer>
    </div>
  );
};

export default App;