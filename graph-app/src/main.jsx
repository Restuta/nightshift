import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import '@xyflow/react/dist/style.css';
import './app.css';

// The board's shared stylesheet (design tokens, masthead, session picker,
// tooltip) is served from the server root — loaded at runtime like the pure
// models, NEVER bundled, so a merged style.css tweak reaches this app with zero
// rebuilds. Injected here (not in index.html) so Vite doesn't try to resolve it
// at build time.
const shared = document.createElement('link');
shared.rel = 'stylesheet';
shared.href = '/style.css';
document.head.insertBefore(shared, document.head.querySelector('link[rel=stylesheet]'));

// A crash must say so on screen — this is a flight recorder, silence is the
// one unacceptable failure mode.
class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div className="gf-crash mono">
          <b>graph view crashed</b>
          <pre>{String(this.state.err && this.state.err.stack || this.state.err)}</pre>
          <a href={'/graph-svg' + location.search}>open the legacy SVG view</a>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(<Boundary><App /></Boundary>);
