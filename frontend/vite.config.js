import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        host: true,
        proxy: {
            '/ui': {
                target: 'http://127.0.0.1:4000',
                changeOrigin: true,
            },
            '/health': {
                target: 'http://127.0.0.1:4000',
                changeOrigin: true,
            }
        }
    }
});