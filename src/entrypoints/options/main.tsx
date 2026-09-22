import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/ui/tailwind.css';
import { OptionsApp } from './App';
import { RuntimeBackend } from '@/ui/messaging';

const container = document.getElementById('app');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <OptionsApp backend={new RuntimeBackend()} />
    </StrictMode>,
  );
}
