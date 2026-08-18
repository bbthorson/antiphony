import type { SqlClient } from '../ports/sql-client.js';

/**
 * Whether a store HAS ANYTHING, as distinct from whether it is wired.
 *
 * ## The incident this exists for
 *
 * The DNS cutover preceded both data migrations. For ~20 minutes
 * `api.antiphony.dev` served an empty Neon and an empty R2, and every surface
 * said it was fine: `/health` returned `{"ok":true,"backend":"postgres"}`
 * throughout, post listings returned `{"success":true,"items":[]}`, and blob
 * requests 404ed exactly as they would for a wrong CID. A consuming app told a
 * caller their account had no voicemail set up.
 *
 * Nothing in that list is a bug. A successful query returning zero rows is
 * indistinguishable from "this tenant has nothing" at every layer above it, and
 * `backend` was answering the question it was designed to answer. The gap is
 * that no surface answered the OTHER question, and the spec recorded exactly
 * this fix: "a row count, or a `records: present|empty` signal, would have
 * turned a 20-minute diagnosis into a glance."
 *
 * ## Why `unavailable` is a third state rather than an error
 *
 * A presence probe must never be the reason `/health` fails. A broken database
 * already shows up in `backend`, and a health endpoint that 500s because a
 * diagnostic query timed out has made the outage worse to diagnose rather than
 * easier. So every failure — no binding, a missing table, a timeout — collapses
 * to `unavailable`, which is itself the useful reading: it says "I could not
 * tell", not "there is nothing".
 */
export type Presence = 'present' | 'empty' | 'unavailable';

export interface DataPresence {
    /** Any rows in `posts`. The records half of a cutover. */
    records: Presence;
    /** Any object under `blobs/`. The bytes half, and the half that 404s. */
    blobs: Presence;
}

/** The one R2 capability this needs, which `R2BucketLike` does not carry. */
export interface R2ListLike {
    list(options?: { prefix?: string; limit?: number }): Promise<{ objects: unknown[] }>;
}

/**
 * Bounded, because this runs on the request path of `/health`.
 *
 * 800ms is chosen against what it protects: a probe that takes longer than this
 * has already failed at being a glance, and the answer it would eventually give
 * is worth less than answering promptly that it could not tell.
 */
const PROBE_TIMEOUT_MS = 800;

async function withinBudget<T>(work: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS);
            }),
        ]);
    } catch {
        // A rejected probe is the same answer as a slow one: could not tell.
        return fallback;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * `posts` rather than every table, and `exists` rather than `count`.
 *
 * `count(*)` on a growing table is a sequential scan for an answer this does not
 * need — "is there at least one" is what distinguishes a cutover that moved data
 * from one that did not, and `exists` stops at the first row. `posts` is the
 * table whose emptiness produced the incident; `audio_transcripts` is derived
 * from it and cannot be non-empty while `posts` is empty.
 */
async function recordsPresence(sql: SqlClient | undefined): Promise<Presence> {
    if (!sql) return 'unavailable';
    return withinBudget(
        (async (): Promise<Presence> => {
            const rows = await sql.query<{ present: boolean }>(
                'select exists(select 1 from posts limit 1) as present',
            );
            return rows[0]?.present ? 'present' : 'empty';
        })(),
        'unavailable',
    );
}

/**
 * Scoped to the `blobs/` prefix on purpose: `renditions/` can be non-empty while
 * every canonical blob is missing, and a rendition without its source is not
 * audio anyone can play.
 */
async function blobsPresence(bucket: R2ListLike | undefined): Promise<Presence> {
    if (!bucket || typeof bucket.list !== 'function') return 'unavailable';
    return withinBudget(
        (async (): Promise<Presence> => {
            const listed = await bucket.list({ prefix: 'blobs/', limit: 1 });
            return listed.objects.length > 0 ? 'present' : 'empty';
        })(),
        'unavailable',
    );
}

/** Both halves, concurrently — the budget is per probe, not per call. */
export async function dataPresence(input: {
    sql?: SqlClient;
    bucket?: R2ListLike;
}): Promise<DataPresence> {
    const [records, blobs] = await Promise.all([
        recordsPresence(input.sql),
        blobsPresence(input.bucket),
    ]);
    return { records, blobs };
}

/**
 * The reading that mattered, named once so `/health` and the cron agree.
 *
 * `records: present` with `blobs: empty` IS the incident: post views hydrate
 * with embeds, and every one of those URLs 404s. It is worth separating from a
 * deployment that is simply new, because the two need opposite responses —
 * one is an availability incident, the other is Tuesday.
 */
export function isAudioBlackout(presence: DataPresence): boolean {
    return presence.records === 'present' && presence.blobs === 'empty';
}
