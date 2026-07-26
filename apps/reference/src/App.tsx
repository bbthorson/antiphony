import { useMemo, useState } from 'react';
import { AntiphonyClient } from './lib/api';
import { PostComposer } from './components/PostComposer';
import { PostView } from './components/PostView';

/** Display only — the BFF, not the browser, decides where requests actually go. */
const CORE_API_LABEL = import.meta.env.VITE_CORE_API_LABEL ?? 'http://localhost:8090';

/**
 * Antiphony reference app — the contract's acceptance harness.
 *
 * Drives the full loop against core-api: record → upload → create
 * `dev.antiphony.audio.post` → fetch hydrated `AudioPostView` → render.
 * Deliberately unbranded: it proves the PROTOCOL is usable by a neutral
 * client built only on `@antiphony/shared` + the public REST surface.
 *
 * Requests go to `/api/v1/*` on this origin; the dev BFF
 * (`server/dev-bff.ts`) holds the service token and forwards them.
 */
export function App() {
    const client = useMemo(() => new AntiphonyClient(), []);
    const [createdId, setCreatedId] = useState<string | null>(null);

    return (
        <main className="app">
            <header>
                <h1>Antiphony · Reference</h1>
                <p className="muted">
                    Neutral creation harness — record, upload, create a
                    <code> dev.antiphony.audio.post</code>, and render the hydrated view.
                </p>
                <p className="muted small">core-api: <code>{CORE_API_LABEL}</code> (via the dev BFF)</p>
            </header>

            <PostComposer client={client} onCreated={setCreatedId} />

            {createdId && (
                <>
                    <div className="row">
                        <span className="muted">Created post id: <code>{createdId}</code></span>
                        <button className="btn btn-ghost" onClick={() => setCreatedId(null)}>New post</button>
                    </div>
                    <PostView client={client} postId={createdId} />
                </>
            )}
        </main>
    );
}
