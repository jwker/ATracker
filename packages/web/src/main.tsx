import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './receipt.css';
import { App } from './App.tsx';

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 挂载点');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
