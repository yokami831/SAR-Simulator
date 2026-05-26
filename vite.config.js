import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy target — follow the backend's resolved port if Electron shifted it.
const dev = process.env.HIYOCANVAS_SERVER_PORT || '18731';

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Separate large vendor libraries into their own chunks
          'vendor-xyflow': ['@xyflow/react', '@xyflow/system'],
          'vendor-codemirror': ['@codemirror/lang-python', '@codemirror/view', '@codemirror/state'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${dev}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${dev}`, ws: true },
    },
  },
});
