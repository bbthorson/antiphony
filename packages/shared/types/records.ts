import { z } from 'zod';

// #region Core Schemas
// =================================================================================================

/**
 * Firestore Timestamp schema (strict).
 *
 * Accepts the shapes Firestore-derived timestamps come back as across our
 * transports (admin SDK Timestamp object, ISO string, epoch number, native
 * Date), and produces a `Date`. **The Date is validated** — if the input
 * coerces to an Invalid Date (e.g. `new Date("")` or a malformed string),
 * the parse fails loudly via a `ZodIssue` rather than returning a
 * downstream-crashing value.
 */
export const FirestoreTimestampSchema = z.union([
    z.custom<unknown>((data: unknown) => {
        return (
            data &&
            typeof data === 'object' &&
            (typeof (data as { toDate?: unknown }).toDate === 'function' || ('seconds' in data && 'nanoseconds' in data))
        );
    }),
    z.string(),
    z.number(),
    z.date()
]).transform((data: unknown, ctx) => {
    let date: Date;
    if (data instanceof Date) {
        date = data;
    } else if (typeof data === 'string') {
        date = new Date(data);
    } else if (typeof data === 'number') {
        date = new Date(data);
    } else if (typeof (data as { toDate?: () => Date }).toDate === 'function') {
        date = (data as { toDate: () => Date }).toDate();
    } else {
        const timestamp = data as { seconds: number; nanoseconds: number };
        date = new Date(timestamp.seconds * 1000 + timestamp.nanoseconds / 1000000);
    }
    if (Number.isNaN(date.getTime())) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'FirestoreTimestamp coerced to Invalid Date',
        });
        return z.NEVER;
    }
    return date;
});
export type FirestoreTimestamp = Date;

// #endregion
