import { AwsClient } from 'aws4fetch';

/**
 * R2 access for this service — the one place in Antiphony that needs a stored
 * R2 credential.
 *
 * Everywhere else, R2 is a Worker binding: authorisation comes from being bound,
 * which is why `adapters/outbound/r2/blob-store.ts` in core-api has no signing
 * code at all and why dropping `getSignedUrl` made that adapter simpler rather
 * than harder. This service runs outside the Workers runtime and cannot hold a
 * binding, so it gets S3 API keys. `specs/archive/cloudflare-migration.md` § Secrets
 * names it as the exception.
 *
 * ## Why `aws4fetch` and not the AWS SDK
 *
 * SigV4 over `fetch` in ~5KB, versus `@aws-sdk/client-s3`'s several megabytes of
 * transitive dependencies for three operations. This is the same call the Cloud
 * Tasks adapter made about `@google-cloud/tasks` and its gRPC tree, and for the
 * same reason: a REST surface with three verbs does not justify a client
 * library, and this monorepo has already been bitten twice by dependencies whose
 * weight brought their own failure modes.
 *
 * ## Ports, still
 *
 * Three methods behind an interface, so the transcoder's tests run with no
 * network and no credentials — the property the Vox Pop version's
 * `RenditionCache` port was introduced for, kept.
 */

export interface BlobStore {
    /** Object bytes, or null when absent. */
    read(objectPath: string): Promise<Buffer | null>;
    /** Object size in bytes, or null when absent. No body transferred. */
    head(objectPath: string): Promise<number | null>;
    /** Write bytes. Overwriting with identical content is expected. */
    write(objectPath: string, bytes: Buffer, contentType: string): Promise<void>;
}

/**
 * Read config, or explain what is missing.
 *
 * Returns the reason rather than throwing at module load, so importing this file
 * never requires credentials — which is what lets the transcoder's own tests
 * import it. `index.ts` fails the process at startup instead, where the message
 * is a startup log line rather than an unhandled module-evaluation error.
 */
export function r2Config():
    | { config: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }; missing?: undefined }
    | { config?: undefined; missing: string[] } {
    const accountId = process.env.R2_ACCOUNT_ID?.trim();
    const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
    const bucket = process.env.ANTIPHONY_R2_BUCKET?.trim() || 'antiphony-r2-bucket';

    const missing: string[] = [];
    if (!accountId) missing.push('R2_ACCOUNT_ID');
    if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID');
    if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');

    if (missing.length > 0) return { missing };
    return { config: { accountId: accountId!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, bucket } };
}

/**
 * The S3-compatible binding, built lazily on first use.
 *
 * Lazy for the same reason the config read above does not throw: module import
 * must not need credentials. Memoised because `AwsClient` derives a signing key
 * per instance and rebuilding it per request would redo that work on every
 * transcode.
 */
let client: { aws: AwsClient; base: string } | null = null;

function connection(): { aws: AwsClient; base: string } {
    if (client) return client;
    const resolved = r2Config();
    if (!resolved.config) {
        throw new Error(`[blob-store] R2 is not configured: missing ${resolved.missing.join(', ')}`);
    }
    const { accountId, accessKeyId, secretAccessKey, bucket } = resolved.config;
    client = {
        aws: new AwsClient({
            accessKeyId,
            secretAccessKey,
            // R2's S3 API is region-less but SigV4 requires a region string,
            // and `auto` is the value R2 documents for it.
            service: 's3',
            region: 'auto',
        }),
        base: `https://${accountId}.r2.cloudflarestorage.com/${bucket}`,
    };
    return client;
}

/**
 * Object paths are composed by the caller from validated segments, but they
 * still have to survive being placed in a URL. Encoding each segment
 * individually keeps the `/` separators as separators while escaping anything
 * inside a segment — which, given the segments are already `[A-Za-z0-9_-]+`
 * plus a format suffix, should be a no-op and is here so that it stays one if
 * that ever loosens.
 */
function objectUrl(base: string, objectPath: string): string {
    return `${base}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
}

export const r2BlobStore: BlobStore = {
    async read(objectPath) {
        const { aws, base } = connection();
        const res = await aws.fetch(objectUrl(base, objectPath));
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new Error(`[blob-store] read failed (${res.status}) for ${objectPath}`);
        }
        return Buffer.from(await res.arrayBuffer());
    },

    async head(objectPath) {
        const { aws, base } = connection();
        const res = await aws.fetch(objectUrl(base, objectPath), { method: 'HEAD' });
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new Error(`[blob-store] head failed (${res.status}) for ${objectPath}`);
        }
        const length = Number(res.headers.get('content-length') ?? '0');
        return Number.isFinite(length) ? length : 0;
    },

    async write(objectPath, bytes, contentType) {
        const { aws, base } = connection();
        const res = await aws.fetch(objectUrl(base, objectPath), {
            method: 'PUT',
            body: new Uint8Array(bytes),
            headers: { 'content-type': contentType },
        });
        if (!res.ok) {
            throw new Error(`[blob-store] write failed (${res.status}) for ${objectPath}`);
        }
    },
};

/** The binding in use. */
export const blobStore: BlobStore = r2BlobStore;
