import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LangProvider, ThemeProvider } from './i18n';
import './style.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root element');
}

createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <LangProvider>
        <App />
      </LangProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
