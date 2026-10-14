import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// FFmpeg's worker needs cross-origin isolation. Production hosts get the same headers from public/_headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  // Relative asset paths so the site works from a GitHub Pages subfolder like /clubcut/.
  base: './',
  plugins: [react()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
})
