import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Self-hosted fonts: the page says documents never leave the browser, and a
// stylesheet fetched from Google would make that claim visibly false.
import '@fontsource-variable/archivo/wght.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'

import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
