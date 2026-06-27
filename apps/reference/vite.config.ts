import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the Antiphony reference app.
 *
 * Port 3002 is deliberate: core-api's default CORS allowlist
 * (`parseAllowedOrigins` fallback) already includes `http://localhost:3002`,
 * so the browser-direct calls to `/api/v1/*` work with zero CORS config on
 * a fresh `npm run dev`. Override via `ALLOWED_ORIGINS` on core-api if you
 * change this.
 */
export default defineConfig({
    plugins: [react()],
    server: {
        port: 3002,
        strictPort: true,
    },
});
