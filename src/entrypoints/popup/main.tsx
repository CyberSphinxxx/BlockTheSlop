import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/ui/tailwind.css';
import { PopupApp } from './App';
import { RuntimeBackend } from '@/ui/messaging';

const container = document.getElementById('app');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <PopupApp backend={new RuntimeBackend()} />
    </StrictMode>,
  );
}
