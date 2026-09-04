import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyTheme, loadTheme } from './ui/theme';
import './index.css';

// Stamp the stored colour scheme on the document before the first render so
// canvas-drawn geometry and charts pick up the right palette immediately.
applyTheme(loadTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
