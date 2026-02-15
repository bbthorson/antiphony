import { z } from 'zod';
/**
 * Public Profile DTO — the public-facing profile shape.
 * Equivalent to ProfileViewBasicSchema plus a few enrichment fields.
 */
export declare const PublicProfileDtoSchema: z.ZodObject<{
    id: z.ZodString;
    handle: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    displayName: z.ZodOptional<z.ZodString>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    bio: z.ZodOptional<z.ZodString>;
    stats: z.ZodOptional<z.ZodObject<{
        followers: z.ZodDefault<z.ZodNumber>;
        following: z.ZodDefault<z.ZodNumber>;
        prompts: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        followers: number;
        following: number;
        prompts: number;
    }, {
        followers?: number | undefined;
        following?: number | undefined;
        prompts?: number | undefined;
    }>>;
    badges: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    isVerified: z.ZodOptional<z.ZodBoolean>;
    createdAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
} & {
    bluesky: z.ZodOptional<z.ZodObject<{
        handle: z.ZodString;
        did: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        handle: string;
        did: string;
    }, {
        handle: string;
        did: string;
    }>>;
    rssFeedUrl: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    isVerified?: boolean | undefined;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    rssFeedUrl?: string | null | undefined;
    createdAt?: Date | undefined;
    stats?: {
        followers: number;
        following: number;
        prompts: number;
    } | undefined;
    badges?: string[] | undefined;
    bluesky?: {
        handle: string;
        did: string;
    } | undefined;
}, {
    id: string;
    isVerified?: boolean | undefined;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    rssFeedUrl?: string | null | undefined;
    createdAt?: unknown;
    stats?: {
        followers?: number | undefined;
        following?: number | undefined;
        prompts?: number | undefined;
    } | undefined;
    badges?: string[] | undefined;
    bluesky?: {
        handle: string;
        did: string;
    } | undefined;
}>;
export type PublicProfileDto = z.infer<typeof PublicProfileDtoSchema>;
/**
 * Public Reply DTO
 * Excludes internal fields or sensitive metadata if any.
 */
export declare const PublicReplyDtoSchema: z.ZodObject<{
    id: z.ZodString;
    audioUrl: z.ZodString;
    duration: z.ZodOptional<z.ZodNumber>;
    createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
    transcription: z.ZodOptional<z.ZodString>;
    sentiment: z.ZodOptional<z.ZodEnum<["Positive", "Negative", "Neutral"]>>;
    aiSummary: z.ZodOptional<z.ZodString>;
    author: z.ZodObject<{
        id: z.ZodString;
        handle: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        displayName: z.ZodOptional<z.ZodString>;
        avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        bio: z.ZodOptional<z.ZodString>;
        stats: z.ZodOptional<z.ZodObject<{
            followers: z.ZodDefault<z.ZodNumber>;
            following: z.ZodDefault<z.ZodNumber>;
            prompts: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            followers: number;
            following: number;
            prompts: number;
        }, {
            followers?: number | undefined;
            following?: number | undefined;
            prompts?: number | undefined;
        }>>;
        badges: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        isVerified: z.ZodOptional<z.ZodBoolean>;
        createdAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
    } & {
        bluesky: z.ZodOptional<z.ZodObject<{
            handle: z.ZodString;
            did: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            handle: string;
            did: string;
        }, {
            handle: string;
            did: string;
        }>>;
        rssFeedUrl: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        isVerified?: boolean | undefined;
        handle?: string | null | undefined;
        displayName?: string | undefined;
        bio?: string | undefined;
        avatarUrl?: string | null | undefined;
        rssFeedUrl?: string | null | undefined;
        createdAt?: Date | undefined;
        stats?: {
            followers: number;
            following: number;
            prompts: number;
        } | undefined;
        badges?: string[] | undefined;
        bluesky?: {
            handle: string;
            did: string;
        } | undefined;
    }, {
        id: string;
        isVerified?: boolean | undefined;
        handle?: string | null | undefined;
        displayName?: string | undefined;
        bio?: string | undefined;
        avatarUrl?: string | null | undefined;
        rssFeedUrl?: string | null | undefined;
        createdAt?: unknown;
        stats?: {
            followers?: number | undefined;
            following?: number | undefined;
            prompts?: number | undefined;
        } | undefined;
        badges?: string[] | undefined;
        bluesky?: {
            handle: string;
            did: string;
        } | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    audioUrl: string;
    id: string;
    createdAt: Date;
    author: {
        id: string;
        isVerified?: boolean | undefined;
        handle?: string | null | undefined;
        displayName?: string | undefined;
        bio?: string | undefined;
        avatarUrl?: string | null | undefined;
        rssFeedUrl?: string | null | undefined;
        createdAt?: Date | undefined;
        stats?: {
            followers: number;
            following: number;
            prompts: number;
        } | undefined;
        badges?: string[] | undefined;
        bluesky?: {
            handle: string;
            did: string;
        } | undefined;
    };
    aiSummary?: string | undefined;
    transcription?: string | undefined;
    sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
    duration?: number | undefined;
}, {
    audioUrl: string;
    id: string;
    author: {
        id: string;
        isVerified?: boolean | undefined;
        handle?: string | null | undefined;
        displayName?: string | undefined;
        bio?: string | undefined;
        avatarUrl?: string | null | undefined;
        rssFeedUrl?: string | null | undefined;
        createdAt?: unknown;
        stats?: {
            followers?: number | undefined;
            following?: number | undefined;
            prompts?: number | undefined;
        } | undefined;
        badges?: string[] | undefined;
        bluesky?: {
            handle: string;
            did: string;
        } | undefined;
    };
    createdAt?: unknown;
    aiSummary?: string | undefined;
    transcription?: string | undefined;
    sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
    duration?: number | undefined;
}>;
export type PublicReplyDto = z.infer<typeof PublicReplyDtoSchema>;
/**
 * Actor View — the full view returned to the authenticated user about themselves.
 * Uses ProfileViewSelfSchema which includes private settings but not admin fields.
 */
export declare const ActorViewSchema: z.ZodObject<{
    id: z.ZodString;
    handle: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    displayName: z.ZodOptional<z.ZodString>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    bio: z.ZodOptional<z.ZodString>;
    stats: z.ZodOptional<z.ZodObject<{
        followers: z.ZodDefault<z.ZodNumber>;
        following: z.ZodDefault<z.ZodNumber>;
        prompts: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        followers: number;
        following: number;
        prompts: number;
    }, {
        followers?: number | undefined;
        following?: number | undefined;
        prompts?: number | undefined;
    }>>;
    badges: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    isVerified: z.ZodOptional<z.ZodBoolean>;
    createdAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
} & {
    bluesky: z.ZodOptional<z.ZodObject<{
        handle: z.ZodString;
        did: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        handle: string;
        did: string;
    }, {
        handle: string;
        did: string;
    }>>;
    rssFeedUrl: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    usageIntent: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    rssSummary: z.ZodOptional<z.ZodObject<{
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        items: z.ZodOptional<z.ZodArray<z.ZodObject<{
            title: z.ZodOptional<z.ZodString>;
            link: z.ZodOptional<z.ZodString>;
            content: z.ZodOptional<z.ZodString>;
            pubDate: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            title?: string | undefined;
            link?: string | undefined;
            content?: string | undefined;
            pubDate?: string | undefined;
        }, {
            title?: string | undefined;
            link?: string | undefined;
            content?: string | undefined;
            pubDate?: string | undefined;
        }>, "many">>;
        lastFetchedAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
    }, "strip", z.ZodTypeAny, {
        title?: string | undefined;
        description?: string | undefined;
        items?: {
            title?: string | undefined;
            link?: string | undefined;
            content?: string | undefined;
            pubDate?: string | undefined;
        }[] | undefined;
        lastFetchedAt?: Date | undefined;
    }, {
        title?: string | undefined;
        description?: string | undefined;
        items?: {
            title?: string | undefined;
            link?: string | undefined;
            content?: string | undefined;
            pubDate?: string | undefined;
        }[] | undefined;
        lastFetchedAt?: unknown;
    }>>;
    promptAudioUrl: z.ZodOptional<z.ZodString>;
    totalPrompts: z.ZodOptional<z.ZodNumber>;
    totalReplies: z.ZodOptional<z.ZodNumber>;
    favoritePromptId: z.ZodOptional<z.ZodString>;
} & {
    phoneNumber: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    email: z.ZodOptional<z.ZodString>;
    lastSeenAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
    lastActiveAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
    unreadReplyCount: z.ZodDefault<z.ZodNumber>;
    newReplierCount: z.ZodDefault<z.ZodNumber>;
    settings: z.ZodOptional<z.ZodObject<{
        notifications: z.ZodOptional<z.ZodBoolean>;
        theme: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        notifications?: boolean | undefined;
        theme?: string | undefined;
    }, {
        notifications?: boolean | undefined;
        theme?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    unreadReplyCount: number;
    newReplierCount: number;
    isVerified?: boolean | undefined;
    phoneNumber?: string | null | undefined;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    rssFeedUrl?: string | null | undefined;
    usageIntent?: string | null | undefined;
    email?: string | undefined;
    createdAt?: Date | undefined;
    stats?: {
        followers: number;
        following: number;
        prompts: number;
    } | undefined;
    badges?: string[] | undefined;
    bluesky?: {
        handle: string;
        did: string;
    } | undefined;
    rssSummary?: {
        title?: string | undefined;
        description?: string | undefined;
        items?: {
            title?: string | undefined;
            link?: string | undefined;
            content?: string | undefined;
            pubDate?: string | undefined;
        }[] | undefined;
        lastFetchedAt?: Date | undefined;
    } | undefined;
    promptAudioUrl?: string | undefined;
    totalPrompts?: number | undefined;
    totalReplies?: number | undefined;
    favoritePromptId?: string | undefined;
    lastSeenAt?: Date | undefined;
    lastActiveAt?: Date | undefined;
    settings?: {
        notifications?: boolean | undefined;
        theme?: string | undefined;
    } | undefined;
}, {
    id: string;
    isVerified?: boolean | undefined;
    phoneNumber?: string | null | undefined;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    rssFeedUrl?: string | null | undefined;
    usageIntent?: string | null | undefined;
    email?: string | undefined;
    createdAt?: unknown;
    stats?: {
        followers?: number | undefined;
        following?: number | undefined;
        prompts?: number | undefined;
    } | undefined;
    badges?: string[] | undefined;
    bluesky?: {
        handle: string;
        did: string;
    } | undefined;
    rssSummary?: {
        title?: string | undefined;
        description?: string | undefined;
        items?: {
            title?: string | undefined;
            link?: string | undefined;
            content?: string | undefined;
            pubDate?: string | undefined;
        }[] | undefined;
        lastFetchedAt?: unknown;
    } | undefined;
    promptAudioUrl?: string | undefined;
    totalPrompts?: number | undefined;
    totalReplies?: number | undefined;
    favoritePromptId?: string | undefined;
    lastSeenAt?: unknown;
    lastActiveAt?: unknown;
    unreadReplyCount?: number | undefined;
    newReplierCount?: number | undefined;
    settings?: {
        notifications?: boolean | undefined;
        theme?: string | undefined;
    } | undefined;
}>;
export type ActorView = z.infer<typeof ActorViewSchema>;
