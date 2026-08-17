/**
 * Structured JSON logger — one line per record, on `console`.
 *
 * Deliberately the same shape core-api's logger emits: same keys, same numeric
 * levels. Two services in one system that log differently are two log formats to
 * query, and this one's records are read alongside core-api's when a rendition
 * fails to appear.
 *
 * Not pino, which the Vox Pop version used, for the reason core-api dropped it:
 * it resolves platform-specific transport scripts through `require()` at module
 * scope, and what this codebase actually wants from it — single-line JSON on
 * stdout — is thirty lines of `JSON.stringify`.
 */

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, silent: Infinity } as const;

type LevelName = keyof typeof LEVELS;

let cachedRaw: string | undefined;
let cachedThreshold: number | undefined;

/**
 * An unrecognised `LOG_LEVEL` falls back to the default rather than silencing
 * everything: a typo that turned logging off would be indistinguishable from a
 * healthy quiet service, which is the failure you notice last and want least.
 */
function threshold(): number {
    const raw = process.env.LOG_LEVEL;
    if (raw === cachedRaw && cachedThreshold !== undefined) return cachedThreshold;
    cachedRaw = raw;
    const named = raw?.trim().toLowerCase() as LevelName | undefined;
    const fallback = process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug;
    cachedThreshold = named && named in LEVELS ? LEVELS[named] : fallback;
    return cachedThreshold;
}

function emit(level: LevelName, a: object | string, b?: string): void {
    if (LEVELS[level] < threshold()) return;
    const context = typeof a === 'string' ? undefined : a;
    const msg = typeof a === 'string' ? a : b;
    // `...context` first so caller context cannot overwrite the record's own
    // fields.
    console.log(
        JSON.stringify({
            ...context,
            level: LEVELS[level],
            time: Date.now(),
            service: 'audio-rendition',
            msg,
        }),
    );
}

export const logger = {
    debug: (a: object | string, b?: string) => emit('debug', a, b),
    info: (a: object | string, b?: string) => emit('info', a, b),
    warn: (a: object | string, b?: string) => emit('warn', a, b),
    error: (a: object | string, b?: string) => emit('error', a, b),
};
