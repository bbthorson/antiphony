import { useMemo, useState } from 'react';
import { AntiphonyClient } from './lib/api';
import { getAuthToken } from './lib/firebase';
import { PostComposer } from './components/PostComposer';
import { PostView } from './components/PostView';

const BASE_URL = import.meta.env.VITE_CORE_API_BASE_URL ?? 'http://localhost:8090';

/**
 * Antiphony reference app — the contract's acceptance harness.
 *
 * Drives the full loop against core-api: record → upload → create
 * `dev.antiphony.audio.post` → fetch hydrated `AudioPostView` → render.
 * Deliberately unbranded: it proves the PROTOCOL is usable by a neutral
 * client built only on `@antiphony/shared` + the public REST surface.
 */
export function App() {
    const client = useMemo(() => new AntiphonyClient(BASE_URL, getAuthToken), []);
    const [createdId, setCreatedId] = useState<string | null>(null);

    return (
        <main className="app">
            <header>
                <h1>Antiphony · Reference</h1>
                <p className="muted">
                    Neutral creation harness — record, upload, create a
                    <code> dev.antiphony.audio.post</code>, and render the hydrated view.
                </p>
                <p className="muted small">core-api: <code>{BASE_URL}</code></p>
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
