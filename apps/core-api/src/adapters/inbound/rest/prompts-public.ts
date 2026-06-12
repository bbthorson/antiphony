import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
    ProfileViewBasicSchema,
    PromptViewPublicSchema,
    toProfileViewBasic,
    toPromptViewPublic,
} from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { userService, promptService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * GET /api/v1/prompts/public/:handle/:promptId
 *
 * Legacy mobile endpoint — returns `{ user: ProfileView, prompt: PromptView }`
 * for the mobile app's public prompt screen. Public; no auth.
 *
 * The `handle` segment is normalized: trim leading `@`, lowercase,
 * URL-decode. The prompt is only returned if it belongs to the
 * resolved user AND is currently live — otherwise 404 (hides both
 * ownership and existence).
 *
 * Parity with: apps/web/src/app/api/v1/prompts/public/[handle]/[promptId]/route.ts
 *
 * This endpoint is a long-lived mobile contract; see
 * `specs/decoupling-migration.md` End State for the mobile cutover plan.
 */

// Public endpoint — project to the basic/public shapes so PII (email, tier,
// lastSeenAt, …) and owner-only prompt fields (analytics, aiStatus/aiError,
// moderation) never serialize to anonymous callers. `toPromptViewPublic` also
// projects the nested `prompt.author` down to the basic shape.
const PublicPromptResponseSchema = z.object({
    user: ProfileViewBasicSchema,
    prompt: PromptViewPublicSchema,
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const getPublicPromptRoute = createRoute({
    method: 'get',
    path: '/{handle}/{promptId}',
    tags: ['Prompts'],
    summary: 'Legacy mobile public-prompt endpoint',
    description: 'Returns `{ user, prompt }` for the mobile app\'s public prompt screen. The handle is normalized (trim `@`, lowercased). Returns 404 if the prompt isn\'t owned by the handle\'s user OR isn\'t live — hides both ownership and existence.',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            handle: z.string().openapi({ description: 'The user handle (case-insensitive; optional leading `@`)' }),
            promptId: z.string().openapi({ description: 'The prompt id' }),
        }),
    },
    responses: {
        200: jsonResponse(PublicPromptResponseSchema, 'User + prompt payload for the public mobile screen'),
        400: errorResponse('Missing handle or promptId'),
        404: errorResponse('Prompt not found'),
    },
});

app.openapi(getPublicPromptRoute, async (c) => {
    // `c.req.param()` already URL-decodes the path segment (unlike Next.js's
    // raw `params` object). Double-decoding would throw on literal `%`
    // characters and corrupt anything that happens to look like an encoded
    // sequence. Trust Hono's decode.
    const rawHandle = c.req.param('handle');
    const promptId = c.req.param('promptId');

    const handle = rawHandle ? rawHandle.toLowerCase().replace(/^@/, '') : '';

    if (!handle || !promptId) {
        return c.json(errorEnvelope(c, 'Missing handle or promptId'), 400);
    }

    // Parallel reads — user + prompt are independent.
    const [user, prompt] = await Promise.all([
        userService.getUserData(handle),
        promptService.getPromptData(promptId),
    ]);

    if (!user || !prompt) {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
    }

    // Verify prompt belongs to this user AND is live. Mismatch = 404
    // (not 403) so the endpoint doesn't confirm that promptId exists.
    if (prompt.record.authorId !== user.id || prompt.record.status !== 'live') {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
    }

    return c.json({
        success: true as const,
        data: {
            user: toProfileViewBasic(user),
            prompt: toPromptViewPublic(prompt),
        },
    }, 200);
});

export { app as promptsPublicRoute };
