import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './styles.css';
import { captureEmailLink, createRuntime } from './client/runtime';

const runtime = createRuntime();
const handoff = captureEmailLink();
const emailLink = runtime.mode === 'api' ? handoff : undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App runtime={runtime} emailLink={emailLink} />
  </StrictMode>,
);
