import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { bootTestMode, isTestMode } from './testing/hooks'

const root = document.getElementById('root')!

if (isTestMode()) {
  bootTestMode(root)
} else {
  createRoot(root).render(<App />)
}
