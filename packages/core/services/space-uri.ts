import { fromLegacySpaceUri } from '@atproto/syntax';

/**
 * The space URI forms, and the one place Antiphony reads the old one
 * (specs/spaces-beta-readiness.md, "The URI format").
 *
 * The 2026-11-24 alpha moved space URIs to their own form:
 *
 *     at:space/{spaceDid}/{spaceType}/{skey}[/{authorDid}/{collection}/{rkey}]    since 11-24
 *     at://{spaceDid}/space/{spaceType}/{skey}[/{authorDid}/{collection}/{rkey}]  alpha-era, until 11-24
 *
 * Public URIs, `at://{did}/{collection}/{rkey}`, are unchanged.
 *
 * **Antiphony emits only the new form and accepts only the new form as input.**
 * The old form survives in one place it can't be rewritten: inside record
 * values written before 11-24. A reply's StrongRef and a transcript's
 * `subject` are sealed into the record's CID, so a space reply recorded in the
 * alpha still names its parent in the old form, and always will. Those values
 * are read through {@link normalizeAtUri} before they're compared or indexed,
 * and migration 0012 does the same in SQL for the generated columns built
 * from them.
 *
 * Upstream drops old-form parsing at the beta, so this module keeps no parser
 * of its own for it: `fromLegacySpaceUri` is upstream's, and is temporary too.
 */

/**
 * A URI in the current form: an alpha-era space URI rewritten to `at:space/`,
 * and anything else returned unchanged. Use it on a URI read out of a stored or
 * fetched record value, never on a caller's input, which must already be in the
 * current form.
 */
export function normalizeAtUri(uri: string): string {
    return fromLegacySpaceUri(uri) ?? uri;
}
