import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AdminApp from './components/AdminApp'
import 'streamdown/styles.css'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
)
