import { z } from 'zod';
export declare const UpdateAuthorDataRequestSchema: z.ZodObject<{
    replyId: z.ZodString;
    data: z.ZodObject<{
        isVerified: z.ZodOptional<z.ZodBoolean>;
        authorRating: z.ZodOptional<z.ZodNumber>;
        authorTags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        authorNotes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        isVerified?: boolean | undefined;
        authorRating?: number | undefined;
        authorTags?: string[] | undefined;
        authorNotes?: string | undefined;
    }, {
        isVerified?: boolean | undefined;
        authorRating?: number | undefined;
        authorTags?: string[] | undefined;
        authorNotes?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    replyId: string;
    data: {
        isVerified?: boolean | undefined;
        authorRating?: number | undefined;
        authorTags?: string[] | undefined;
        authorNotes?: string | undefined;
    };
}, {
    replyId: string;
    data: {
        isVerified?: boolean | undefined;
        authorRating?: number | undefined;
        authorTags?: string[] | undefined;
        authorNotes?: string | undefined;
    };
}>;
export declare const CheckPhoneRequestSchema: z.ZodObject<{
    phoneNumber: z.ZodString;
}, "strip", z.ZodTypeAny, {
    phoneNumber: string;
}, {
    phoneNumber: string;
}>;
export declare const SubmitReplyRequestSchema: z.ZodObject<{
    phoneNumber: z.ZodString;
    otp: z.ZodString;
    audioUrl: z.ZodString;
    promptId: z.ZodString;
    userId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    phoneNumber: string;
    otp: string;
    audioUrl: string;
    promptId: string;
    userId: string;
}, {
    phoneNumber: string;
    otp: string;
    audioUrl: string;
    promptId: string;
    userId: string;
}>;
export declare const CreatePromptRequestSchema: z.ZodObject<{
    title: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    audioUrl: z.ZodUnion<[z.ZodString, z.ZodLiteral<"">]>;
    setAsGreeting: z.ZodOptional<z.ZodUnion<[z.ZodBoolean, z.ZodEffects<z.ZodString, boolean, string>]>>;
}, "strip", z.ZodTypeAny, {
    audioUrl: string;
    title: string;
    description?: string | undefined;
    setAsGreeting?: boolean | undefined;
}, {
    audioUrl: string;
    title: string;
    description?: string | undefined;
    setAsGreeting?: string | boolean | undefined;
}>;
export declare const UpdateProfileRequestSchema: z.ZodObject<{
    handle: z.ZodOptional<z.ZodString>;
    displayName: z.ZodOptional<z.ZodString>;
    bio: z.ZodOptional<z.ZodString>;
    avatarUrl: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    rssFeedUrl: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    usageIntent: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    handle?: string | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    rssFeedUrl?: string | null | undefined;
    usageIntent?: string | null | undefined;
}, {
    handle?: string | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | null | undefined;
    rssFeedUrl?: string | null | undefined;
    usageIntent?: string | null | undefined;
}>;
export declare const BetaSignupRequestSchema: z.ZodObject<{
    email: z.ZodString;
    usageIntent: z.ZodString;
    inviteCode: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    usageIntent: string;
    email: string;
    inviteCode?: string | undefined;
}, {
    usageIntent: string;
    email: string;
    inviteCode?: string | undefined;
}>;
