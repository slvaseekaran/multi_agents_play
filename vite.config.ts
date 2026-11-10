import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Fixed port + relative base: required by Tauri (dev server on 1420, bundled files served from the app origin).
export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', outDir: 'dist' },
});
