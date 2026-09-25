import { z } from 'zod';

// #region Core Schemas
// =================================================================================================

/**
 * Timestamp schema (strict).
 *
 * Accepts timestamps across transports (ISO string, epoch number, native Date,
 * or legacy timestamp object with seconds/nanoseconds or toDate()), and produces a `Date`.
 * **The Date is validated** — if the input coerces to an Invalid Date (e.g. `new Date("")`
 * or a malformed string), the parse fails loudly via a `ZodIssue` rather than returning a
 * downstream-crashing value.
 */
export const TimestampSchema = z.union([
    z.object({
        seconds: z.number(),
        nanoseconds: z.number(),
    }),
    z.object({
        toDate: z.unknown(),
    }),
    z.string(),
    z.number(),
    z.date(),
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
            message: 'Timestamp coerced to Invalid Date',
        });
        return z.NEVER;
    }
    return date;
});
export type Timestamp = Date;

// #endregion
