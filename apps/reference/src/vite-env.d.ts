/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_CORE_API_BASE_URL?: string;
    readonly VITE_FIREBASE_PROJECT_ID?: string;
    readonly VITE_FIREBASE_API_KEY?: string;
    readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
    readonly VITE_AUTH_EMULATOR_HOST?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
