import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages non permette header HTTP personalizzati: la CSP viene iniettata
// nell'HTML solo in build, così il dev server (HMR) resta invariato.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self' data: blob:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.emailjs.com",
  "frame-src 'self' blob: https://*.supabase.co",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "form-action 'self'",
  'upgrade-insecure-requests',
].join('; ');

const cspPlugin = {
  name: 'stimia-content-security-policy',
  apply: 'build' as const,
  transformIndexHtml(html: string) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`;
    return html.replace('<head>', `<head>\n    ${meta}`);
  },
};

export default defineConfig({
  // Su GitHub Pages il sito può stare in /nome-repository/
  base: process.env.VITE_BASE_PATH || '/',
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react(), cspPlugin],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  }
});