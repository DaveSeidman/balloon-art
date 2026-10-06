import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/balloon-art/' : '/',
  plugins: [react()],
  assetsInclude: ['**/*.glb', '**/*.hdr'],
})
