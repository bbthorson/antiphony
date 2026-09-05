/**
 * Compute normalized waveform peaks from an audio blob.
 *
 * Returns `buckets` integers in 0–100 — exactly the shape the
 * `dev.antiphony.embed.audio` lexicon's `waveform` field expects
 * (`z.array(z.number().int().min(0).max(100))`). Computed client-side at
 * capture time so the embed carries a cheap, instantly-renderable
 * visualization without waiting on server processing.
 *
 * **The one React-free module in this package**, and deliberately so: it is
 * published at the `@antiphony/capture-kit/waveform` subpath so a consumer
 * that only needs peaks — a Svelte client, a Node script backfilling old
 * posts — can import it without pulling React into the graph.
 */
export async function computeWaveform(blob: Blob, buckets = 64): Promise<number[]> {
    const AudioCtx: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    try {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const channel = audioBuffer.getChannelData(0);
        const blockSize = Math.floor(channel.length / buckets) || 1;

        const peaks: number[] = [];
        let max = 0;
        for (let i = 0; i < buckets; i++) {
            const start = i * blockSize;
            let sum = 0;
            for (let j = 0; j < blockSize; j++) {
                sum += Math.abs(channel[start + j] ?? 0);
            }
            const avg = sum / blockSize;
            peaks.push(avg);
            if (avg > max) max = avg;
        }

        // Normalize to 0–100 ints; guard against a silent (max=0) clip.
        const scale = max > 0 ? 100 / max : 0;
        return peaks.map((p) => Math.min(100, Math.round(p * scale)));
    } finally {
        await ctx.close();
    }
}
