import { Hono } from 'hono';
import { z } from 'zod';
import { toReplyViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { feedService } from '../../outbound/firebase/core-services-firebase.js';
import { getCrmNotes, setCrmNotes } from '../../../lib/crm-notes-store.js';

/**
 * People / CRM endpoints mounted at `/api/v1/people`.
 *
 *   GET /                  — full "People" composite for the dashboard People tab.
 *                            Returns repliers, enriched repliers, and the
 *                            authenticated user's prompts with their replies.
 *   GET /list              — list authenticated user's repliers (EnrichedReplier[]).
 *                            Lighter-weight than `/` — used by widgets that just
 *                            need the people list, not the prompt cross-reference.
 *   GET /:handle/replies   — all replies authored by a specific handle across the
 *                            authenticated user's prompts.
 *
 * All three endpoints derive the owner from the session — no cross-user queries.
 * Reply objects are sanitized via `toReplyViewPublic` before returning so
 * private CRM fields (notes, listenerPhoneNumber) never leak to clients.
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/people/route.ts
 *   apps/web/src/app/api/v1/people/list/route.ts
 *   apps/web/src/app/api/v1/people/[handle]/replies/route.ts
 */

const app = new Hono();

// ---------------------------------------------------------------------------
// GET /api/v1/people — full People-tab composite
// ---------------------------------------------------------------------------
//
// Returns `{ repliers, enrichedRepliers, promptsWithReplies }`. The
// promptsWithReplies array's reply entries are projected through
// `toReplyViewPublic` to strip private fields (notes, listenerPhoneNumber)
// — the CRM notes belong only to the prompt author, and even though
// the caller IS the author, the canonical client-facing shape is
// ReplyViewPublic everywhere.
//
// NOTE: apps/web's parity route did not surface `orgId`. The
// underlying `feedService.getPeopleData` only takes `uid` today. If
// org-scoped composite views are needed, threading orgId through here
// is a follow-up — keep parity for now.

app.get('/', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;

    const peopleData = await feedService.getPeopleData(uid);
    if (!peopleData) {
        return c.json(
            { status: 'error', message: 'Not found', requestId: c.get('requestId') },
            404,
        );
    }

    const sanitizedPromptsWithReplies = peopleData.promptsWithReplies.map((pwr) => ({
        ...pwr,
        replies: pwr.replies.map(toReplyViewPublic),
    }));

    return c.json({
        success: true,
        data: {
            repliers: peopleData.repliers,
            enrichedRepliers: peopleData.enrichedRepliers,
            promptsWithReplies: sanitizedPromptsWithReplies,
        },
    });
});

// ---------------------------------------------------------------------------
// GET /api/v1/people/list?orgId=...
// ---------------------------------------------------------------------------
//
// Lighter "just the people list" variant of GET /api/v1/people. Returns
// only `EnrichedReplier[]`. Used by widgets that don't need the full
// prompts cross-reference. Accepts `orgId` to scope to an org context.
//
// Query params:
//   orgId (optional) — scope to an org context. Missing/empty = personal.

app.get('/list', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgIdRaw = c.req.query('orgId');
    // Treat missing or empty as null (personal context). Matches the service
    // signature's `orgId?: string | null`.
    const orgId = orgIdRaw && orgIdRaw.length > 0 ? orgIdRaw : null;

    const enrichedRepliers = await feedService.getPeopleList(uid, orgId);

    return c.json({ success: true, data: enrichedRepliers });
});

// ---------------------------------------------------------------------------
// GET /api/v1/people/:handle/replies
// ---------------------------------------------------------------------------
//
// All replies authored by `:handle` across the authenticated user's
// prompts, plus a `promptTitles` lookup map so the client can render
// each reply's parent prompt title without a second fetch. Replies
// projected through `toReplyViewPublic`.

app.get('/:handle/replies', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const handle = c.req.param('handle');

    const result = await feedService.getPersonReplies(uid, handle);

    return c.json({
        success: true,
        data: {
            replies: result.replies.map(toReplyViewPublic),
            promptTitles: result.promptTitles,
        },
    });
});

// ---------------------------------------------------------------------------
// GET /api/v1/people/:handle/notes
// ---------------------------------------------------------------------------
//
// Read the authenticated viewer's CRM notes + tags about `:handle`.
// Per-viewer storage: notes are private to the authenticated user,
// not visible to anyone else (including the target). Returns
// `{ notes: '', tags: [] }` when no entry exists — UI uses empty
// defaults rather than treating 404 as "no notes".

app.get('/:handle/notes', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const handle = c.req.param('handle');

    const data = await getCrmNotes(uid, handle);
    return c.json(data);
});

// ---------------------------------------------------------------------------
// POST /api/v1/people/:handle/notes
// ---------------------------------------------------------------------------
//
// Update the viewer's CRM notes + tags about `:handle`. Merge-write —
// omit a field to leave it untouched. Both fields are optional in the
// schema so callers can update just one.

const NotesUpdateSchema = z.object({
    notes: z.string().max(10_000).optional(),
    tags: z.array(z.string().max(64)).max(50).optional(),
});

app.post('/:handle/notes', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const handle = c.req.param('handle');

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            { status: 'error', message: 'Invalid JSON body', requestId: c.get('requestId') },
            400,
        );
    }

    const parsed = NotesUpdateSchema.safeParse(body);
    if (!parsed.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid request body',
                issues: parsed.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    await setCrmNotes(uid, handle, parsed.data);
    return c.json({ success: true });
});

export { app as peopleRoute };
