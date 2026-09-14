import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'
import { applyTheme, watchSystemTheme } from './theme.ts'
import './styles.css'

// 挂载前先落主题，避免深浅切换时首帧闪白
applyTheme()
watchSystemTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
