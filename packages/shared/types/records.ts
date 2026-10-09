import { z } from 'zod';

// #region Core Schemas
// =================================================================================================

/**
 * Timestamp schema (strict).
 *
 * Accepts the two forms a timestamp takes in this system and produces a `Date`:
 *
 *  - a **string** — what a record's timestamps become once serialized, i.e. the
 *    ISO-8601 form stored in the Postgres `jsonb` record column and sent over
 *    the wire (`Date#toJSON`), or the text form of a `timestamptz` column;
 *  - a native **`Date`** — what services construct in memory and what the SQL
 *    driver may hand back for a typed timestamp column.
 *
 * **The Date is validated** — if the input coerces to an Invalid Date (e.g.
 * `new Date("")` or a malformed string), the parse fails loudly via a
 * `ZodIssue` rather than returning a downstream-crashing value.
 */
export const TimestampSchema = z.union([z.string(), z.date()]).transform((data, ctx) => {
    const date = data instanceof Date ? data : new Date(data);
    if (Number.isNaN(date.getTime())) {
        ctx.addIssue({
            code: 'custom',
            message: 'Timestamp coerced to Invalid Date',
        });
        return z.NEVER;
    }
    return date;
});
export type Timestamp = Date;

// #endregion
