import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { StorageService } from '../../outbound/firebase/core-services-firebase.js';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import { logger } from '../../../lib/logger.js';

/**
 * GET /api/v1/audio?url={encodedAudioUrl}
 *
 * Audio proxy. Validates the referenced object path is one we serve
 * (prefix allowlist: `audio/`, `prompts/`, `replies/`) and that any
 * `replies/{promptId}/...` path points at a prompt that exists.
 * Returns a 302 redirect to a time-limited signed URL (1-hour expiry
 * default, cached to the client for 50 min).
 *
 * Parity with: apps/web/src/app/api/v1/audio/route.ts. Phase 1 of the
 * signed-URL migration — see `specs/signed-url-migration.md`.
 *
 * ## Error shape
 * Uses the `{status: 'error', message}` route-return shape (NOT the
 * `{success: false, error}` shape used by the user/org endpoints).
 * Matches apps/web's audio handler exactly — both shapes coexist in
 * the codebase; parity-per-endpoint is the rule.
 */

const prefixedPath = (p: string): boolean =>
    p.startsWith('audio/') || p.startsWith('prompts/') || p.startsWith('replies/');

/**
 * Defense-in-depth against path-traversal bypasses. GCS uses a flat
 * namespace so `..` has no special meaning to the storage layer, but a
 * `..`-containing path that passes the prefix check could escape the
 * allowlist in a hypothetical future storage backend that interprets
 * path segments (local filesystem, S3 with simulated directories, etc.).
 * Reject anywhere on the path — `audio/../../secrets` should fail even
 * though it starts with `audio/`.
 */
const hasTraversalSegment = (p: string): boolean =>
    p.split('/').some((seg) => seg === '..');

const app = new Hono();

app.get('/', rateLimit(RATE_LIMITS.read), async (c) => {
    const audioUrl = c.req.query('url');
    if (!audioUrl) {
        return c.json({ status: 'error', message: 'Missing "url" query parameter' }, 400);
    }

    const objectPath = StorageService.extractObjectPath(audioUrl);
    if (!objectPath) {
        return c.json({ status: 'error', message: 'Invalid audio URL' }, 400);
    }

    if (!prefixedPath(objectPath) || hasTraversalSegment(objectPath)) {
        return c.json({ status: 'error', message: 'Forbidden path' }, 403);
    }

    // For reply audio (`replies/{promptId}/{userId}_{timestamp}.ext`),
    // validate the parent prompt exists. Failing open on Firestore hiccup
    // — consistent with apps/web, which doesn't want a transient DB
    // outage to brick all audio playback.
    if (objectPath.startsWith('replies/')) {
        const parts = objectPath.split('/');
        if (parts.length >= 2) {
            const promptId = parts[1];
            try {
                const promptDoc = await getAdminDb().collection('prompts').doc(promptId).get();
                if (!promptDoc.exists) {
                    return c.json({ status: 'error', message: 'Not found' }, 404);
                }
            } catch (err) {
                logger.error(
                    { err, promptId, requestId: c.get('requestId') },
                    '[audio-proxy] error checking prompt existence; failing open',
                );
            }
        }
    }

    try {
        const signedUrl = await StorageService.getSignedUrl(objectPath);
        // Cache just under the 1-hour signed-URL TTL so clients don't
        // redirect through a URL that's about to expire.
        c.header('Cache-Control', 'private, max-age=3000');
        return c.redirect(signedUrl, 302);
    } catch (err) {
        logger.error(
            { err, objectPath, requestId: c.get('requestId') },
            '[audio-proxy] failed to generate signed URL',
        );
        return c.json({ status: 'error', message: 'Audio not found' }, 404);
    }
});

export { app as audioRoute };
