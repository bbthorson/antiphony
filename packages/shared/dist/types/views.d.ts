import { z } from 'zod';
/**
 * Layered Profile Views
 * Each level extends the previous, adding more fields.
 * This ensures sensitive data is only included when appropriate.
 */
/** Public profile — safe to return to any caller. */
export declare const ProfileViewBasicSchema: z.ZodObject<{
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
}, "strip", z.ZodTypeAny, {
    id: string;
    isVerified?: boolean | undefined;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    createdAt?: Date | undefined;
    stats?: {
        followers: number;
        following: number;
        prompts: number;
    } | undefined;
    badges?: string[] | undefined;
}, {
    id: string;
    isVerified?: boolean | undefined;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    createdAt?: unknown;
    stats?: {
        followers?: number | undefined;
        following?: number | undefined;
        prompts?: number | undefined;
    } | undefined;
    badges?: string[] | undefined;
}>;
export type ProfileViewBasic = z.infer<typeof ProfileViewBasicSchema>;
/** Authenticated viewer — includes enrichment data visible to other users. */
export declare const ProfileViewDetailedSchema: z.ZodObject<{
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
    /** AT Protocol Identity link */
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
    /** Hydrated RSS Data (fetched from sub-collection) */
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
}, "strip", z.ZodTypeAny, {
    id: string;
    isVerified?: boolean | undefined;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    rssFeedUrl?: string | null | undefined;
    usageIntent?: string | null | undefined;
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
}, {
    id: string;
    isVerified?: boolean | undefined;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    rssFeedUrl?: string | null | undefined;
    usageIntent?: string | null | undefined;
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
}>;
export type ProfileViewDetailed = z.infer<typeof ProfileViewDetailedSchema>;
/** Own profile — includes private settings and activity data. */
export declare const ProfileViewSelfSchema: z.ZodObject<{
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
    /** AT Protocol Identity link */
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
    /** Hydrated RSS Data (fetched from sub-collection) */
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
export type ProfileViewSelf = z.infer<typeof ProfileViewSelfSchema>;
/** Admin profile — includes moderation and relationship data. */
export declare const ProfileViewAdminSchema: z.ZodObject<{
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
    /** AT Protocol Identity link */
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
    /** Hydrated RSS Data (fetched from sub-collection) */
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
} & {
    blockedUsers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    followers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    following: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    reportCount: z.ZodOptional<z.ZodNumber>;
    isBanned: z.ZodOptional<z.ZodBoolean>;
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
    followers?: string[] | undefined;
    following?: string[] | undefined;
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
    blockedUsers?: string[] | undefined;
    reportCount?: number | undefined;
    isBanned?: boolean | undefined;
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
    followers?: string[] | undefined;
    following?: string[] | undefined;
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
    blockedUsers?: string[] | undefined;
    reportCount?: number | undefined;
    isBanned?: boolean | undefined;
}>;
export type ProfileViewAdmin = z.infer<typeof ProfileViewAdminSchema>;
/**
 * @deprecated Use the scoped view that matches your access level:
 * - ProfileViewBasicSchema (public)
 * - ProfileViewDetailedSchema (authenticated)
 * - ProfileViewSelfSchema (own profile / GET /users/me)
 * - ProfileViewAdminSchema (admin routes)
 */
export declare const ProfileViewSchema: z.ZodObject<{
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
    /** AT Protocol Identity link */
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
    /** Hydrated RSS Data (fetched from sub-collection) */
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
} & {
    blockedUsers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    followers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    following: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    reportCount: z.ZodOptional<z.ZodNumber>;
    isBanned: z.ZodOptional<z.ZodBoolean>;
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
    followers?: string[] | undefined;
    following?: string[] | undefined;
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
    blockedUsers?: string[] | undefined;
    reportCount?: number | undefined;
    isBanned?: boolean | undefined;
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
    followers?: string[] | undefined;
    following?: string[] | undefined;
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
    blockedUsers?: string[] | undefined;
    reportCount?: number | undefined;
    isBanned?: boolean | undefined;
}>;
export type ProfileView = z.infer<typeof ProfileViewSchema>;
/**
 * A hydrated view of a prompt, including the author's profile.
 */
export declare const PromptViewSchema: z.ZodObject<{
    /** AT Protocol URI (e.g. at://did:plc.../app.../123) */
    uri: z.ZodOptional<z.ZodString>;
    /** IPFS Content ID */
    cid: z.ZodOptional<z.ZodString>;
    /** The raw prompt data */
    record: z.ZodObject<{
        id: z.ZodString;
        authorId: z.ZodString;
        title: z.ZodString;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        audioUrl: z.ZodUnion<[z.ZodString, z.ZodLiteral<"">]>;
        audio: z.ZodOptional<z.ZodObject<{
            $type: z.ZodLiteral<"blob">;
            ref: z.ZodString;
            mimeType: z.ZodString;
            size: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        }, {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        }>>;
        createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
        status: z.ZodDefault<z.ZodEnum<["live", "archived", "deleted"]>>;
        aiStatus: z.ZodOptional<z.ZodEnum<["pending", "complete", "error"]>>;
        aiError: z.ZodOptional<z.ZodString>;
        aiSummary: z.ZodOptional<z.ZodString>;
        aiLabels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        transcription: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "live" | "archived" | "deleted";
        audioUrl: string;
        title: string;
        id: string;
        createdAt: Date;
        authorId: string;
        description?: string | null | undefined;
        audio?: {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        } | undefined;
        aiStatus?: "pending" | "complete" | "error" | undefined;
        aiError?: string | undefined;
        aiSummary?: string | undefined;
        aiLabels?: string[] | undefined;
        transcription?: string | undefined;
    }, {
        audioUrl: string;
        title: string;
        id: string;
        authorId: string;
        status?: "live" | "archived" | "deleted" | undefined;
        description?: string | null | undefined;
        createdAt?: unknown;
        audio?: {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        } | undefined;
        aiStatus?: "pending" | "complete" | "error" | undefined;
        aiError?: string | undefined;
        aiSummary?: string | undefined;
        aiLabels?: string[] | undefined;
        transcription?: string | undefined;
    }>;
    /** The hydrated author profile */
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
        /** AT Protocol Identity link */
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
        /** Hydrated RSS Data (fetched from sub-collection) */
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
    } & {
        blockedUsers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        followers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        following: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        reportCount: z.ZodOptional<z.ZodNumber>;
        isBanned: z.ZodOptional<z.ZodBoolean>;
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
    }>;
    /** Total number of replies */
    replyCount: z.ZodDefault<z.ZodNumber>;
    likeCount: z.ZodDefault<z.ZodNumber>;
    updatedAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
    lastReplyAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    visibility: z.ZodDefault<z.ZodEnum<["public", "private", "unlisted", "archived"]>>;
    analytics: z.ZodOptional<z.ZodObject<{
        views: z.ZodDefault<z.ZodNumber>;
        listens: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        views: number;
        listens: number;
    }, {
        views?: number | undefined;
        listens?: number | undefined;
    }>>;
    moderation: z.ZodOptional<z.ZodObject<{
        flagged: z.ZodDefault<z.ZodBoolean>;
        reason: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        flagged: boolean;
        reason?: string | undefined;
    }, {
        flagged?: boolean | undefined;
        reason?: string | undefined;
    }>>;
    aiScore: z.ZodOptional<z.ZodNumber>;
    aiLabels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    aiSummary: z.ZodOptional<z.ZodString>;
    aiStatus: z.ZodOptional<z.ZodEnum<["pending", "complete", "error"]>>;
    aiError: z.ZodOptional<z.ZodString>;
    transcription: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    record: {
        status: "live" | "archived" | "deleted";
        audioUrl: string;
        title: string;
        id: string;
        createdAt: Date;
        authorId: string;
        description?: string | null | undefined;
        audio?: {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        } | undefined;
        aiStatus?: "pending" | "complete" | "error" | undefined;
        aiError?: string | undefined;
        aiSummary?: string | undefined;
        aiLabels?: string[] | undefined;
        transcription?: string | undefined;
    };
    author: {
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
    };
    replyCount: number;
    likeCount: number;
    visibility: "archived" | "public" | "private" | "unlisted";
    aiStatus?: "pending" | "complete" | "error" | undefined;
    aiError?: string | undefined;
    aiSummary?: string | undefined;
    aiLabels?: string[] | undefined;
    transcription?: string | undefined;
    uri?: string | undefined;
    cid?: string | undefined;
    updatedAt?: Date | undefined;
    lastReplyAt?: Date | undefined;
    tags?: string[] | undefined;
    analytics?: {
        views: number;
        listens: number;
    } | undefined;
    moderation?: {
        flagged: boolean;
        reason?: string | undefined;
    } | undefined;
    aiScore?: number | undefined;
}, {
    record: {
        audioUrl: string;
        title: string;
        id: string;
        authorId: string;
        status?: "live" | "archived" | "deleted" | undefined;
        description?: string | null | undefined;
        createdAt?: unknown;
        audio?: {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        } | undefined;
        aiStatus?: "pending" | "complete" | "error" | undefined;
        aiError?: string | undefined;
        aiSummary?: string | undefined;
        aiLabels?: string[] | undefined;
        transcription?: string | undefined;
    };
    author: {
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
    };
    aiStatus?: "pending" | "complete" | "error" | undefined;
    aiError?: string | undefined;
    aiSummary?: string | undefined;
    aiLabels?: string[] | undefined;
    transcription?: string | undefined;
    uri?: string | undefined;
    cid?: string | undefined;
    replyCount?: number | undefined;
    likeCount?: number | undefined;
    updatedAt?: unknown;
    lastReplyAt?: unknown;
    tags?: string[] | undefined;
    visibility?: "archived" | "public" | "private" | "unlisted" | undefined;
    analytics?: {
        views?: number | undefined;
        listens?: number | undefined;
    } | undefined;
    moderation?: {
        flagged?: boolean | undefined;
        reason?: string | undefined;
    } | undefined;
    aiScore?: number | undefined;
}>;
export type PromptView = z.infer<typeof PromptViewSchema>;
/**
 * A hydrated view of a reply, including author and recipient profiles.
 */
export declare const ReplyViewSchema: z.ZodObject<{
    record: z.ZodObject<{
        id: z.ZodString;
        promptId: z.ZodString;
        authorId: z.ZodString;
        audioUrl: z.ZodString;
        audio: z.ZodOptional<z.ZodObject<{
            $type: z.ZodLiteral<"blob">;
            ref: z.ZodString;
            mimeType: z.ZodString;
            size: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        }, {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        }>>;
        createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
        status: z.ZodDefault<z.ZodEnum<["live", "archived"]>>;
        replyToUri: z.ZodOptional<z.ZodString>;
        notes: z.ZodOptional<z.ZodString>;
        aiStatus: z.ZodOptional<z.ZodEnum<["pending", "complete", "error"]>>;
        aiError: z.ZodOptional<z.ZodString>;
        aiSummary: z.ZodOptional<z.ZodString>;
        aiLabels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        transcription: z.ZodOptional<z.ZodString>;
        sentiment: z.ZodOptional<z.ZodEnum<["Positive", "Negative", "Neutral"]>>;
        energyLevel: z.ZodOptional<z.ZodEnum<["High", "Low"]>>;
        engagementScore: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        status: "live" | "archived";
        audioUrl: string;
        promptId: string;
        id: string;
        createdAt: Date;
        authorId: string;
        audio?: {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        } | undefined;
        aiStatus?: "pending" | "complete" | "error" | undefined;
        aiError?: string | undefined;
        aiSummary?: string | undefined;
        aiLabels?: string[] | undefined;
        transcription?: string | undefined;
        replyToUri?: string | undefined;
        notes?: string | undefined;
        sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
        energyLevel?: "High" | "Low" | undefined;
        engagementScore?: number | undefined;
    }, {
        audioUrl: string;
        promptId: string;
        id: string;
        authorId: string;
        status?: "live" | "archived" | undefined;
        createdAt?: unknown;
        audio?: {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        } | undefined;
        aiStatus?: "pending" | "complete" | "error" | undefined;
        aiError?: string | undefined;
        aiSummary?: string | undefined;
        aiLabels?: string[] | undefined;
        transcription?: string | undefined;
        replyToUri?: string | undefined;
        notes?: string | undefined;
        sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
        energyLevel?: "High" | "Low" | undefined;
        engagementScore?: number | undefined;
    }>;
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
        /** AT Protocol Identity link */
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
        /** Hydrated RSS Data (fetched from sub-collection) */
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
    } & {
        blockedUsers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        followers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        following: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        reportCount: z.ZodOptional<z.ZodNumber>;
        isBanned: z.ZodOptional<z.ZodBoolean>;
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
    }>;
    recipient: z.ZodObject<{
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
        /** AT Protocol Identity link */
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
        /** Hydrated RSS Data (fetched from sub-collection) */
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
    } & {
        blockedUsers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        followers: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        following: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        reportCount: z.ZodOptional<z.ZodNumber>;
        isBanned: z.ZodOptional<z.ZodBoolean>;
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
    }>;
    /** GCS Storage Path for audio file */
    storagePath: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    updatedAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
    isRead: z.ZodBoolean;
    readBy: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    isDeleted: z.ZodDefault<z.ZodBoolean>;
    reactions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    moderation: z.ZodOptional<z.ZodObject<{
        flagged: z.ZodDefault<z.ZodBoolean>;
        reason: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        flagged: boolean;
        reason?: string | undefined;
    }, {
        flagged?: boolean | undefined;
        reason?: string | undefined;
    }>>;
    aiScore: z.ZodOptional<z.ZodNumber>;
    aiLabels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    aiSummary: z.ZodOptional<z.ZodString>;
    aiStatus: z.ZodOptional<z.ZodEnum<["pending", "complete", "error"]>>;
    aiError: z.ZodOptional<z.ZodString>;
    transcription: z.ZodOptional<z.ZodString>;
    sentiment: z.ZodOptional<z.ZodEnum<["Positive", "Negative", "Neutral"]>>;
    energyLevel: z.ZodOptional<z.ZodEnum<["High", "Low"]>>;
    engagementScore: z.ZodOptional<z.ZodNumber>;
    /** @private Confirmed listener phone number (never exposed publicly) */
    listenerPhoneNumber: z.ZodOptional<z.ZodString>;
    isVerified: z.ZodDefault<z.ZodBoolean>;
    authorRating: z.ZodOptional<z.ZodNumber>;
    authorTags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    authorNotes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    isVerified: boolean;
    record: {
        status: "live" | "archived";
        audioUrl: string;
        promptId: string;
        id: string;
        createdAt: Date;
        authorId: string;
        audio?: {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        } | undefined;
        aiStatus?: "pending" | "complete" | "error" | undefined;
        aiError?: string | undefined;
        aiSummary?: string | undefined;
        aiLabels?: string[] | undefined;
        transcription?: string | undefined;
        replyToUri?: string | undefined;
        notes?: string | undefined;
        sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
        energyLevel?: "High" | "Low" | undefined;
        engagementScore?: number | undefined;
    };
    author: {
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
    };
    recipient: {
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
    };
    isRead: boolean;
    readBy: string[];
    isDeleted: boolean;
    authorRating?: number | undefined;
    authorTags?: string[] | undefined;
    authorNotes?: string | undefined;
    aiStatus?: "pending" | "complete" | "error" | undefined;
    aiError?: string | undefined;
    aiSummary?: string | undefined;
    aiLabels?: string[] | undefined;
    transcription?: string | undefined;
    sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
    energyLevel?: "High" | "Low" | undefined;
    engagementScore?: number | undefined;
    updatedAt?: Date | undefined;
    moderation?: {
        flagged: boolean;
        reason?: string | undefined;
    } | undefined;
    aiScore?: number | undefined;
    storagePath?: string | undefined;
    duration?: number | undefined;
    reactions?: Record<string, number> | undefined;
    listenerPhoneNumber?: string | undefined;
}, {
    record: {
        audioUrl: string;
        promptId: string;
        id: string;
        authorId: string;
        status?: "live" | "archived" | undefined;
        createdAt?: unknown;
        audio?: {
            $type: "blob";
            ref: string;
            mimeType: string;
            size: number;
        } | undefined;
        aiStatus?: "pending" | "complete" | "error" | undefined;
        aiError?: string | undefined;
        aiSummary?: string | undefined;
        aiLabels?: string[] | undefined;
        transcription?: string | undefined;
        replyToUri?: string | undefined;
        notes?: string | undefined;
        sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
        energyLevel?: "High" | "Low" | undefined;
        engagementScore?: number | undefined;
    };
    author: {
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
    };
    recipient: {
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
        followers?: string[] | undefined;
        following?: string[] | undefined;
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
        blockedUsers?: string[] | undefined;
        reportCount?: number | undefined;
        isBanned?: boolean | undefined;
    };
    isRead: boolean;
    isVerified?: boolean | undefined;
    authorRating?: number | undefined;
    authorTags?: string[] | undefined;
    authorNotes?: string | undefined;
    aiStatus?: "pending" | "complete" | "error" | undefined;
    aiError?: string | undefined;
    aiSummary?: string | undefined;
    aiLabels?: string[] | undefined;
    transcription?: string | undefined;
    sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
    energyLevel?: "High" | "Low" | undefined;
    engagementScore?: number | undefined;
    updatedAt?: unknown;
    moderation?: {
        flagged?: boolean | undefined;
        reason?: string | undefined;
    } | undefined;
    aiScore?: number | undefined;
    storagePath?: string | undefined;
    duration?: number | undefined;
    readBy?: string[] | undefined;
    isDeleted?: boolean | undefined;
    reactions?: Record<string, number> | undefined;
    listenerPhoneNumber?: string | undefined;
}>;
export type ReplyView = z.infer<typeof ReplyViewSchema>;
/**
 * A view of a beta signup.
 */
export declare const BetaSignupViewSchema: z.ZodObject<{
    record: z.ZodObject<{
        id: z.ZodString;
        email: z.ZodString;
        usageIntent: z.ZodString;
        inviteCode: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
        status: z.ZodDefault<z.ZodEnum<["waitlist", "invited", "joined"]>>;
        generatedInviteCode: z.ZodOptional<z.ZodString>;
        invitedAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
    }, "strip", z.ZodTypeAny, {
        status: "waitlist" | "invited" | "joined";
        usageIntent: string;
        email: string;
        id: string;
        createdAt: Date;
        inviteCode?: string | undefined;
        generatedInviteCode?: string | undefined;
        invitedAt?: Date | undefined;
    }, {
        usageIntent: string;
        email: string;
        id: string;
        status?: "waitlist" | "invited" | "joined" | undefined;
        inviteCode?: string | undefined;
        createdAt?: unknown;
        generatedInviteCode?: string | undefined;
        invitedAt?: unknown;
    }>;
}, "strip", z.ZodTypeAny, {
    record: {
        status: "waitlist" | "invited" | "joined";
        usageIntent: string;
        email: string;
        id: string;
        createdAt: Date;
        inviteCode?: string | undefined;
        generatedInviteCode?: string | undefined;
        invitedAt?: Date | undefined;
    };
}, {
    record: {
        usageIntent: string;
        email: string;
        id: string;
        status?: "waitlist" | "invited" | "joined" | undefined;
        inviteCode?: string | undefined;
        createdAt?: unknown;
        generatedInviteCode?: string | undefined;
        invitedAt?: unknown;
    };
}>;
export type BetaSignupView = z.infer<typeof BetaSignupViewSchema>;
export declare const OrganizationViewSchema: z.ZodObject<{
    record: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        avatarUrl: z.ZodOptional<z.ZodString>;
        ownerId: z.ZodString;
        createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
        stripeCustomerId: z.ZodOptional<z.ZodString>;
        subscriptionStatus: z.ZodOptional<z.ZodEnum<["active", "trialing", "past_due", "canceled", "unpaid"]>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        createdAt: Date;
        name: string;
        ownerId: string;
        avatarUrl?: string | undefined;
        stripeCustomerId?: string | undefined;
        subscriptionStatus?: "active" | "trialing" | "past_due" | "canceled" | "unpaid" | undefined;
    }, {
        id: string;
        name: string;
        ownerId: string;
        avatarUrl?: string | undefined;
        createdAt?: unknown;
        stripeCustomerId?: string | undefined;
        subscriptionStatus?: "active" | "trialing" | "past_due" | "canceled" | "unpaid" | undefined;
    }>;
    memberCount: z.ZodDefault<z.ZodNumber>;
    currentUserRole: z.ZodOptional<z.ZodEnum<["owner", "admin", "member"]>>;
}, "strip", z.ZodTypeAny, {
    record: {
        id: string;
        createdAt: Date;
        name: string;
        ownerId: string;
        avatarUrl?: string | undefined;
        stripeCustomerId?: string | undefined;
        subscriptionStatus?: "active" | "trialing" | "past_due" | "canceled" | "unpaid" | undefined;
    };
    memberCount: number;
    currentUserRole?: "owner" | "admin" | "member" | undefined;
}, {
    record: {
        id: string;
        name: string;
        ownerId: string;
        avatarUrl?: string | undefined;
        createdAt?: unknown;
        stripeCustomerId?: string | undefined;
        subscriptionStatus?: "active" | "trialing" | "past_due" | "canceled" | "unpaid" | undefined;
    };
    memberCount?: number | undefined;
    currentUserRole?: "owner" | "admin" | "member" | undefined;
}>;
export type OrganizationView = z.infer<typeof OrganizationViewSchema>;
export interface VoxPopEmbedWidgetProps {
    promptId?: string;
    targetUserId?: string;
    onRecordingStateChange?: (isRecording: boolean) => void;
    className?: string;
}
export declare const PromptRepliersSchema: z.ZodObject<{
    promptId: z.ZodString;
    repliers: z.ZodRecord<z.ZodString, z.ZodObject<{
        firstReplyAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
        lastReplyAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
        replyCount: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        replyCount: number;
        lastReplyAt: Date;
        firstReplyAt: Date;
    }, {
        replyCount: number;
        lastReplyAt?: unknown;
        firstReplyAt?: unknown;
    }>>;
}, "strip", z.ZodTypeAny, {
    promptId: string;
    repliers: Record<string, {
        replyCount: number;
        lastReplyAt: Date;
        firstReplyAt: Date;
    }>;
}, {
    promptId: string;
    repliers: Record<string, {
        replyCount: number;
        lastReplyAt?: unknown;
        firstReplyAt?: unknown;
    }>;
}>;
export type PromptRepliers = z.infer<typeof PromptRepliersSchema>;
export type PromptWithReplies = PromptView & {
    replies: ReplyView[];
};
export interface Replier {
    handle: string;
    lastReplyDate: string;
    firstReplyAt: string;
    totalReplies: number;
}
