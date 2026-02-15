import { z } from 'zod';
export declare const PromptDocumentSchema: z.ZodObject<{
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
} & {
    replyCount: z.ZodDefault<z.ZodNumber>;
    lastReplyAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
}, "strip", z.ZodTypeAny, {
    status: "live" | "archived" | "deleted";
    audioUrl: string;
    title: string;
    id: string;
    createdAt: Date;
    authorId: string;
    replyCount: number;
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
    lastReplyAt?: Date | undefined;
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
    replyCount?: number | undefined;
    lastReplyAt?: unknown;
}>;
export type PromptDocument = z.infer<typeof PromptDocumentSchema>;
/**
 * The ReplyDocument (Storage Schema).
 * Currently identical to ReplyRecordSchema as there are no computed fields stored on the Reply document itself.
 */
export declare const ReplyDocumentSchema: z.ZodObject<{
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
export type ReplyDocument = z.infer<typeof ReplyDocumentSchema>;
