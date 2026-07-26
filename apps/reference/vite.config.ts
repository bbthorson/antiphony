import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { devBff } from './server/dev-bff';

/**
 * Vite config for the Antiphony reference app.
 *
 * The app calls `/api/v1/*` on its OWN origin; the `devBff` plugin holds the
 * core-api service token and forwards those calls server-side (see
 * `server/dev-bff.ts` for why that hop is mandatory rather than stylistic).
 *
 * Because nothing is cross-origin any more, core-api's `ALLOWED_ORIGINS` no
 * longer constrains this app — including against the live API, which
 * deliberately doesn't allowlist localhost.
 */
export default defineConfig(({ mode }) => {
    // Load .env files with an EMPTY prefix so the server-side vars
    // (`ANTIPHONY_SERVICE_TOKEN`, `ANTIPHONY_CORE_API_URL`, …) reach
    // process.env for the dev BFF. Vite still only inlines `VITE_`-prefixed
    // vars into the client bundle, so the token cannot leak into it.
    Object.assign(process.env, loadEnv(mode, process.cwd(), ''));

    return {
        plugins: [react(), devBff()],
        server: { port: 3002, strictPort: true },
        preview: { port: 3002, strictPort: true },
    };
});
