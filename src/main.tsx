import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createSession } from './app/composition';
import { App } from './ui/App';
import './ui/styles.css';

const session = createSession();
const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found.');
}

createRoot(root).render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
);
