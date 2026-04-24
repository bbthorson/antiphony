import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

// firebase-admin is CommonJS. Node's ESM loader only exposes the default
// export; named imports like `import { credential } from 'firebase-admin'`
// fail at runtime. Destructure from the default namespace instead.
const { credential } = admin;

/**
 * Firebase Admin SDK bootstrap for core-api. Mirrors
 * `apps/web/src/lib/firebase/admin.ts` with three differences:
 *
 *   1. No `server-only` import — that's a Next.js package and core-api is
 *      a plain Node service. Core-api is server-only by construction.
 *   2. Emulator detection reads `VOXPOP_USE_EMULATOR` (not
 *      `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` — we've got no `NEXT_PUBLIC_*`
 *      convention here). During Phase 4a transition the same Firebase
 *      emulators that apps/web uses cover both backends.
 *   3. Logging is via pino in this codebase, not Winston — but bootstrap
 *      uses `console` directly because the logger module would import
 *      this one at module-load time and we'd hit a cycle.
 *
 * Lazy-init pattern: the Admin SDK is initialized on the first call to any
 * accessor (`getAdminDb`, `getAdminAuth`, etc.), not at module-load, so
 * test harnesses and build tools that import this file can do so without
 * booting a real Firebase connection.
 *
 * Credentials:
 *   - Production: `ADMIN_SERVICE_ACCOUNT_JSON` env var (set as an App Hosting
 *     secret) — matches apps/web's convention so both backends share one
 *     secret during Phase 4a. Per `specs/decoupling-migration.md` Post-4a
 *     Follow-ups: split into two service accounts after the flip stabilizes.
 *   - Fallback: Application Default Credentials (useful for local gcloud
 *     auth or GCP-managed-identity environments).
 *   - Emulator: anonymous credential; project ID comes from env.
 */

const appName = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'vox-pop-core-api';

let adminApp: admin.app.App | undefined;

function getAdminApp(): admin.app.App {
    if (adminApp) return adminApp;

    // If another module-load or framework has already initialized a same-named
    // app, reuse it (avoids "app already exists" on hot reload).
    const existing = admin.apps.find((a) => a?.name === appName);
    if (existing) {
        adminApp = existing;
        return adminApp;
    }

    const useEmulators = process.env.VOXPOP_USE_EMULATOR === 'true';

    if (useEmulators) {
        // Emulator hosts mirror apps/web's defaults so both backends hit the
        // same emulator instance during local dev.
        process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
        process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
        process.env.FIREBASE_STORAGE_EMULATOR_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';

        const emulatorProjectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'vox-pop-simple';
        adminApp = admin.initializeApp(
            {
                projectId: emulatorProjectId,
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${emulatorProjectId}.appspot.com`,
            },
            appName,
        );
        console.log('[firebase-admin] connected to emulators');
        return adminApp;
    }

    let cred: admin.credential.Credential;
    if (process.env.ADMIN_SERVICE_ACCOUNT_JSON) {
        try {
            const serviceAccount = JSON.parse(process.env.ADMIN_SERVICE_ACCOUNT_JSON);
            cred = credential.cert(serviceAccount);
        } catch (e) {
            console.error('[firebase-admin] failed to parse ADMIN_SERVICE_ACCOUNT_JSON, falling back to ADC', e);
            cred = credential.applicationDefault();
        }
    } else {
        cred = credential.applicationDefault();
    }

    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
    adminApp = admin.initializeApp(
        {
            credential: cred,
            databaseURL: projectId ? `https://${projectId}.firebaseio.com` : undefined,
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET || (projectId ? `${projectId}.appspot.com` : undefined),
        },
        appName,
    );
    console.log(`[firebase-admin] initialized production app: ${appName}`);
    return adminApp;
}

let adminDb: FirebaseFirestore.Firestore | undefined;

export function getAdminDb(): FirebaseFirestore.Firestore {
    if (adminDb) return adminDb;
    const db = getFirestore(getAdminApp());
    try {
        db.settings({ ignoreUndefinedProperties: true });
    } catch (error: unknown) {
        // Settings are idempotent if already applied on this Firestore instance;
        // swallow the "already initialized" error that fires during hot reload.
        const e = error as { code?: string; message?: string };
        if (e.code !== 'FAILED_PRECONDITION' && !(e.message && e.message.includes('already been initialized'))) {
            throw error;
        }
    }
    adminDb = db;
    return db;
}

export function getAdminAuth() {
    return getAuth(getAdminApp());
}

export function getAdminStorage() {
    return getStorage(getAdminApp());
}

export function isUsingEmulator(): boolean {
    return process.env.VOXPOP_USE_EMULATOR === 'true';
}

/** Access to the `admin` namespace for callers that need `admin.firestore.FieldValue` etc. */
export function getAdmin() {
    getAdminApp();
    return admin;
}
