import { Hono } from 'hono';
import { toReplyViewPublic } from 'shared/types/views';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { feedService, organizationService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * People / CRM endpoints mounted at `/api/v1/people`.
 *
 *   GET /                  — full "People" composite for the dashboard People tab.
 *                            Returns repliers, enriched repliers, and the
 *                            authenticated user's prompts with their replies.
 *   GET /list              — list authenticated user's repliers (EnrichedReplier[]).
 *                            Lighter-weight than `/` — used by widgets that just
 *                            need the people list, not the prompt cross-reference.
 *
 * Both endpoints derive the owner from the session — no cross-user queries.
 * Reply objects are sanitized via `toReplyViewPublic` before returning so
 * private CRM fields (notes, listenerPhoneNumber) never leak to clients.
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/people/route.ts
 *   apps/web/src/app/api/v1/people/list/route.ts
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
        return c.json(errorEnvelope(c, 'Not found'), 404);
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

    // IDOR guard: an `orgId` scopes the query to that org's prompts and their
    // repliers (incl. lite-user phone numbers). Without a membership check any
    // authenticated caller could enumerate any org's audience. Personal context
    // (orgId === null) reads only the caller's own prompts, so no check needed.
    if (orgId) {
        // Validate the shape before it reaches a Firestore doc path. An orgId
        // is a single path segment (UUID / Firestore auto-id); a value with `/`
        // or other unexpected characters would throw an invalid-reference error
        // deep in getMemberRole. Reject it at the boundary with a clean 400.
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(orgId)) {
            return c.json(errorEnvelope(c, 'Invalid orgId'), 400);
        }
        const role = await organizationService.getMemberRole(orgId, uid);
        if (!role) {
            return c.json(errorEnvelope(c, 'Not a member of this organization'), 403);
        }
    }

    const enrichedRepliers = await feedService.getPeopleList(uid, orgId);

    return c.json({ success: true, data: enrichedRepliers });
});

// NOTE: a person's activity timeline (formerly `GET /:handle/replies`) is now
// served by the cross-prompt reply feed: `GET /api/v1/replies/feed?authorUid=`
// scopes the viewer's feed to one author (keyed on the immutable `authorId`).
// The client derives the per-reply prompt titles from the viewer's own prompt
// list, so the bespoke handle-keyed endpoint + `feedService.getPersonReplies`
// were retired.

// NOTE: per-viewer CRM notes/tags (`GET`/`POST /:handle/notes`) moved off
// core-api to the relationships service (tier-2, today's `apps/identity`),
// re-keyed on the target's immutable uid (`/people/:targetUid/notes`). The
// legacy handle-keyed `users/{viewerUid}/crm/{handle}` store was migrated by
// `scripts/migrate-crm-notes-to-enrichments.ts`. core-api stays tier-1: it
// no longer carries any viewer-private relationship state.

export { app as peopleRoute };
