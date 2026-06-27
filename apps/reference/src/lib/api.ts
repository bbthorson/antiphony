import type { CreateAudioPostRequest } from '@antiphony/shared/api-codecs';
import type { AudioPostView } from '@antiphony/shared/types/audio';

/**
 * Typed client for the Antiphony core-api `/posts` + `/audio` surface.
 *
 * This is the whole point of the reference app: a NEUTRAL client that drives
 * the published contract end to end using only `@antiphony/shared` types —
 * no product-specific code. If the shapes here drift from what core-api
 * emits, the build breaks, which is exactly the acceptance signal we want.
 */

/** The core-api response envelope (mirrors lib/error-envelope on the server). */
type Envelope<T> =
    | { success: true; data: T }
    | { success: false; error: { message: string; code?: string }; requestId: string };

export class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
        super(message);
        this.name = 'ApiError';
    }
}

export class AntiphonyClient {
    constructor(
        private readonly baseUrl: string,
        private readonly getToken: () => Promise<string>,
    ) {}

    private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
        const token = await this.getToken();
        const res = await fetch(`${this.baseUrl}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(init.headers ?? {}),
            },
        });

        let body: Envelope<T>;
        try {
            body = (await res.json()) as Envelope<T>;
        } catch {
            throw new ApiError(`Non-JSON response (${res.status})`, res.status);
        }

        if (!body.success) {
            throw new ApiError(body.error?.message ?? `Request failed (${res.status})`, res.status, body.error?.code);
        }
        return body.data;
    }

    /**
     * Upload audio bytes. core-api stores them and returns the canonical
     * storage URL that goes into the embed's `audio.ref`.
     */
    async uploadAudio(blob: Blob, filename: string): Promise<string> {
        const form = new FormData();
        // Re-wrap with a clean MIME (MediaRecorder appends `;codecs=opus`,
        // which the upload allowlist rejects on exact match).
        const cleanType = blob.type.split(';')[0] || 'audio/webm';
        form.append('file', new Blob([blob], { type: cleanType }), filename);
        const data = await this.request<{ audioUrl: string }>('/api/v1/audio/upload', {
            method: 'POST',
            body: form,
        });
        return data.audioUrl;
    }

    /** Create a `dev.antiphony.audio.post`. Returns the new post id. */
    async createPost(req: CreateAudioPostRequest): Promise<string> {
        const data = await this.request<{ postId: string }>('/api/v1/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
        });
        return data.postId;
    }

    /** Fetch a hydrated post view (signed audio URL + lifted transcript + viewer state). */
    async getPost(id: string): Promise<AudioPostView> {
        return this.request<AudioPostView>(`/api/v1/posts/${encodeURIComponent(id)}`, {
            method: 'GET',
        });
    }
}
