import { z } from 'zod';

/**
 * Channels — the user-facing inbound/outbound surface over the connector
 * control-plane. See `specs/channels.md`.
 *
 * Phase 1 is a **read-model only**: `GET /api/v1/users/me/channels` projects the
 * scattered per-user channel state (the `telephony` connector envelope, the SIP
 * enrichment doc, the profile's linked Bluesky identity, plus the always-on web
 * / RSS / embed surfaces) into one uniform list. No storage migration — this
 * file defines the projection's shape and the static descriptor registry that
 * both the API (overlaying per-user state) and the settings UI (rendering rows)
 * agree on.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * The known channels. Distinct from `ConnectorTypeSchema` (the storage-layer
 * connector allowlist, currently just `telephony`): a channel is the *product*
 * concept, which may map onto a connector, an always-on surface, or a
 * not-yet-built capability.
 */
export const ChannelTypeSchema = z.enum([
    // inbound
    'web-capture',
    'phone',
    'bluesky-replies',
    // outbound
    'bluesky-publishing',
    'phone-voicemail',
    'rss',
    'embed',
    'sms-invites',
]);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const ChannelDirectionSchema = z.enum(['inbound', 'outbound', 'bidirectional']);
export type ChannelDirection = z.infer<typeof ChannelDirectionSchema>;

/**
 * Generic, render-without-channel-knowledge lifecycle. The first five mirror
 * `ConnectorStatus.state`; `coming-soon` marks a registered-but-unbuilt channel
 * so the UI can show it greyed without a special case.
 */
export const ChannelStateSchema = z.enum([
    'active',
    'pending',
    'disabled',
    'unconfigured',
    'error',
    'coming-soon',
]);
export type ChannelState = z.infer<typeof ChannelStateSchema>;

// ---------------------------------------------------------------------------
// Per-channel view (one row in the settings UI)
// ---------------------------------------------------------------------------

export const ChannelViewSchema = z.object({
    type: ChannelTypeSchema,
    direction: ChannelDirectionSchema,
    /** Human label, e.g. "Phone", "Bluesky publishing". */
    label: z.string(),
    /** One-line explanation rendered under the label. */
    description: z.string(),
    /** Generic lifecycle state the UI renders as a status pill. */
    state: ChannelStateSchema,
    /** Channel-specific human detail (e.g. a verification failure reason). */
    statusDetail: z.string().nullable().optional(),
    /** Whether the channel is currently switched on for this user. */
    enabled: z.boolean(),
    /** Always-on surfaces (web capture, RSS, embed) — no real disable. */
    alwaysOn: z.boolean(),
    /** Whether there's a per-channel config screen to open. */
    configurable: z.boolean(),
    /** Requires a paid tier to use (see `docs/feature-gates.md`). */
    gated: z.boolean(),
    /**
     * A prerequisite that must be satisfied elsewhere before this channel works,
     * e.g. `'bluesky-identity'` for Bluesky publishing. Null when self-contained.
     */
    dependsOn: z.string().nullable().optional(),
});
export type ChannelView = z.infer<typeof ChannelViewSchema>;

/** The `GET /users/me/channels` response payload (inside the standard envelope). */
export const ChannelsResponseSchema = z.object({
    inbound: z.array(ChannelViewSchema),
    outbound: z.array(ChannelViewSchema),
});
export type ChannelsResponse = z.infer<typeof ChannelsResponseSchema>;

// ---------------------------------------------------------------------------
// Static descriptor registry — product metadata, identical for every user.
// The API overlays per-user `state` / `enabled` / `statusDetail` on top.
// ---------------------------------------------------------------------------

export interface ChannelDescriptor {
    type: ChannelType;
    direction: ChannelDirection;
    label: string;
    description: string;
    /** No stored config; presence-only status row. */
    alwaysOn: boolean;
    /** Has a config screen (Phase 1 surfaces the flag; screens come later). */
    configurable: boolean;
    /** Paid-tier gated. */
    gated: boolean;
    /** Cross-channel prerequisite (rendered as a "needs …" hint). */
    dependsOn: string | null;
    /** Registered but not built yet — forces `state: 'coming-soon'`. */
    comingSoon: boolean;
}

/**
 * The single source of truth for which channels exist and how they present.
 * Order within each direction is the display order in the settings UI.
 */
export const CHANNEL_DESCRIPTORS: readonly ChannelDescriptor[] = [
    // ── Inbound ──────────────────────────────────────────────────────────
    {
        type: 'web-capture',
        direction: 'inbound',
        label: 'Web capture',
        description: 'Replies left on your public prompt page and embedded widgets.',
        alwaysOn: true,
        configurable: false,
        gated: false,
        dependsOn: null,
        comingSoon: false,
    },
    {
        type: 'phone',
        direction: 'inbound',
        // Inbound voice. Call forwarding and the SIP address are two ingress
        // addresses of this one channel, not separate channels — both deliver a
        // voice reply to the same inbox over the same telephony substrate.
        label: 'Phone',
        description: 'Forward calls — or point a VoIP softphone (SIP) — at your Vox Pop inbox.',
        alwaysOn: false,
        configurable: true,
        gated: false,
        dependsOn: null,
        comingSoon: false,
    },
    {
        type: 'bluesky-replies',
        direction: 'inbound',
        label: 'Bluesky replies',
        description: 'Pull replies and mentions from Bluesky into your inbox.',
        alwaysOn: false,
        configurable: false,
        gated: false,
        dependsOn: 'bluesky-identity',
        comingSoon: true,
    },
    // ── Outbound ─────────────────────────────────────────────────────────
    {
        type: 'bluesky-publishing',
        direction: 'outbound',
        label: 'Bluesky publishing',
        description: 'Publish your prompts to Bluesky.',
        alwaysOn: false,
        configurable: true,
        gated: false,
        dependsOn: 'bluesky-identity',
        comingSoon: false,
    },
    {
        type: 'phone-voicemail',
        direction: 'outbound',
        // The outbound face of telephony: when a caller reaches the line, the
        // IVR plays the creator's inbox prompt as the voicemail greeting and
        // offers their live prompts as keypad options (apps/telephony
        // IvrService). That is the creator's prompt distributed by phone — a
        // genuine outbound surface, not a coming-soon placeholder. Config (the
        // greeting = the inbox prompt) is managed via prompts, so no inline
        // Configure screen yet → configurable:false for now.
        label: 'Phone voicemail',
        description: 'Callers hear your prompt as the voicemail greeting, then leave a reply.',
        alwaysOn: false,
        configurable: false,
        gated: false,
        dependsOn: null,
        comingSoon: false,
    },
    {
        type: 'rss',
        direction: 'outbound',
        label: 'RSS feed',
        description: 'A podcast-ready feed of your prompts and replies.',
        alwaysOn: true,
        configurable: false,
        gated: false,
        dependsOn: null,
        comingSoon: false,
    },
    {
        type: 'embed',
        direction: 'outbound',
        label: 'Embed widget',
        description: 'Drop a capture widget onto your own site.',
        alwaysOn: true,
        configurable: false,
        gated: false,
        dependsOn: null,
        comingSoon: false,
    },
    {
        type: 'sms-invites',
        direction: 'outbound',
        label: 'SMS invites',
        description: 'Text a prompt link to your audience.',
        alwaysOn: false,
        configurable: true,
        gated: true,
        dependsOn: null,
        comingSoon: true,
    },
] as const;

/** Lookup a descriptor by type. */
export function getChannelDescriptor(type: ChannelType): ChannelDescriptor {
    const d = CHANNEL_DESCRIPTORS.find((c) => c.type === type);
    // Exhaustive by construction — every ChannelType has a descriptor above.
    if (!d) throw new Error(`No channel descriptor for type: ${type}`);
    return d;
}
