/// <reference types="vite/client" />

/**
 * Client-visible env. Deliberately tiny: the app holds no credential, so
 * there is nothing here but a display string. The service token and the
 * core-api URL are server-side vars read by `server/dev-bff.ts` — they carry
 * no `VITE_` prefix precisely so Vite cannot inline them into this bundle.
 */
interface ImportMetaEnv {
    /** Display only — which core-api the BFF forwards to, shown in the header. */
    readonly VITE_CORE_API_LABEL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
