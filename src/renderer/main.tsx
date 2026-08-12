import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import './styles/tokens.css'
import './styles/global.css'
import './styles/prism-theme.css'

const rootElement = document.getElementById('root')

if (rootElement === null) {
  throw new Error('RENDERER_ROOT_MISSING')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
