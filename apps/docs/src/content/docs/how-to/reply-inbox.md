---
title: Build a reply inbox on the core
description: A worked recipe — orchestrate the replies primitives (feed, read, status, notes, search) into a working inbox UI.
---

There is no `GET /inbox`. An "inbox" is a UX surface you *compose* from primitives — and that's the design rule of the whole API, made concrete (see [Architecture & connectors](/explanation/connectors/) for the *why*). This recipe wires the replies endpoints into a working inbox against only documented public endpoints.

Everything here is on the consumer plane (`/api/v1/replies/*`) and needs a bearer token — see [Authentication](/api/overview/#authentication). All responses use the standard [envelope](/api/overview/#envelope): unwrap `{ success, data }`, handle `{ success: false, error }`.

## The primitives an inbox is made of

| Step | Endpoint | Role in the inbox |
|---|---|---|
| List | `GET /api/v1/replies/feed` | The cross-prompt, reverse-chronological, cursor-paginated list. |
| Read one | `GET /api/v1/replies/{replyId}` | Detail view of a single reply. |
| Mark read | `POST /api/v1/replies/{replyId}/read` | Clear the unread badge as the viewer opens a reply. |
| Triage | `PATCH /api/v1/replies/{replyId}/status` | Archive / restore / delete a reply (`live` ↔ `archived` ↔ `deleted`). |
| Annotate | `PATCH /api/v1/replies/{replyId}/notes` | Private CRM notes on a reply (owner-only, never public). |
| Batch | `POST /api/v1/replies/bulk-action` | Apply `markRead` / `archive` / `delete` / `restore` to up to 100 ids at once. |
| Search | `GET /api/v1/replies/search` | Substring search over reply transcriptions. |

None of these *is* the inbox. The inbox is what you build by sequencing them.

The examples below assume a tiny helper that attaches the token and unwraps the envelope:

```ts
const BASE = import.meta.env.VITE_CORE_API_BASE_URL ?? 'http://localhost:8080';

async function api(path: string, token: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE}/api/v1${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...init.headers,
        },
    });
    const body = await res.json();
    if (!body.success) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    return body.data;
}
```

## 1. List the feed (and page through it)

`GET /replies/feed` returns the authenticated viewer's replies across *all* their prompts, newest first. The contract for paging is a single rule: **read `data.nextCursor`; if it's non-null, pass it back as `cursor` to get the next page.** When it comes back `null`, you've reached the end.

```ts
// One page. data === { items: ReplyView[], nextCursor: string | null }
async function fetchPage(token: string, cursor?: string, readStatus = 'all') {
    const qs = new URLSearchParams({ limit: '20', readStatus });
    if (cursor) qs.set('cursor', cursor);
    return api(`/replies/feed?${qs}`, token);
}

// The whole inbox: drain every page.
async function* allReplies(token: string) {
    let cursor: string | undefined;
    do {
        const page = await fetchPage(token, cursor);
        for (const reply of page.items) yield reply;
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
}
```

The feed is built for inbox filtering. Every parameter is optional:

| Query param | Effect | Default |
|---|---|---|
| `limit` | Page size, clamped to 1–100. | `20` |
| `cursor` | The last reply id from the prior page. | — |
| `promptId` | Scope to one prompt (a per-prompt inbox). | all prompts |
| `authorUid` | Scope to one person's replies to you. | everyone |
| `status` | `live` / `archived` / `all`. | `live` |
| `readStatus` | `all` / `read` / `unread`. | `all` |
| `dateFrom`, `dateTo` | Inclusive ISO datetime bounds. | unbounded |

So `?readStatus=unread` is your unread view, `?status=archived` is the archive tab, and `?promptId=…&status=all` is the full history for one prompt. Each item is a `ReplyView` — `{ record, author, recipient, isRead }`, where `record` carries `id`, `promptId`, `audioUrl`, `transcription`, `createdAt`, and `audioDurationSec`. Wrap `record.audioUrl` in the [audio proxy](/build-your-own/embed-example/#audio-playback-goes-through-the-proxy) before playing it.

## 2. Mark a reply read when it's opened

When the viewer opens a reply, clear its unread state. `POST /replies/{replyId}/read` adds the viewer to the reply's read set; it's **idempotent** (calling it twice is harmless) and needs no ownership — anyone who can see the reply can mark their own view of it read.

```ts
await api(`/replies/${replyId}/read`, token, { method: 'POST' });
```

Pair this with `readStatus=unread` from step 1 and you have the classic unread-count → open → mark-read loop, with no client-side bookkeeping: the next feed fetch reflects the new state.

## 3. Triage: archive, restore, delete

Triage is a status flip. `PATCH /replies/{replyId}/status` moves a reply between `live`, `archived`, and `deleted`. Unlike marking read, this **requires you to own the parent prompt** — it's the creator curating their own replies.

```ts
// Archive one reply out of the live view.
await api(`/replies/${replyId}/status`, token, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'archived' }),
});
```

For multi-select — "archive these 12" — don't loop. `POST /replies/bulk-action` applies one action (`markRead`, `archive`, `delete`, `restore`) to up to 100 ids in a single call:

```ts
await api('/replies/bulk-action', token, {
    method: 'POST',
    body: JSON.stringify({ replyIds: selected, action: 'archive' }),
});
```

Unlike the single-reply endpoint in step 2, **every** bulk action — `markRead` included — requires you to own each reply's parent prompt (you get a `403` otherwise); `markRead` is still idempotent.

## 4. Add private notes (the CRM layer)

`PATCH /replies/{replyId}/notes` attaches a private annotation (up to 5000 chars) to a reply — your own "follow up with this person" jotting. Owner-of-the-parent-prompt only.

```ts
await api(`/replies/${replyId}/notes`, token, {
    method: 'PATCH',
    body: JSON.stringify({ notes: 'Loved this — invite to the beta.' }),
});
```

Notes are deliberately **private**: they live on a separate enrichments record and never appear in any reply's public projection, so they're safe for internal triage. They're a write primitive — persist what your UI captures; don't expect them echoed back in the public feed payload.

## 5. Search across the inbox

`GET /replies/search` does a case-insensitive substring match over reply transcriptions. It takes a required `q` (min 2 characters) plus the same `promptId` / `status` / `readStatus` / `dateFrom` / `dateTo` filters as the feed:

```ts
const { items } = await api(
    `/replies/search?${new URLSearchParams({ q: 'beta', status: 'all' })}`,
    token,
);
```

Search returns a flat `items` list (it isn't cursor-paginated like the feed) — wire it to the same row renderer you used in step 1 and you have inbox search for free.

## What you just built

A list, an unread loop, triage (single and bulk), private notes, and search — a complete inbox, assembled entirely from documented `/api/v1/replies/*` primitives. The core never shipped an "inbox" endpoint, and it didn't need to: the composition lives in your connector, which is exactly the point of the [hub-and-connector model](/explanation/connectors/). Swap the read-state loop for stars, the status flip for custom labels, and it's a different inbox against the same contract.

## Where next?

- [Architecture & connectors](/explanation/connectors/) — why the core ships primitives and you compose the experience.
- [Example: the embed app](/build-your-own/embed-example/) — a minimal read-only connector, end to end.
- [API reference](/api/reference/) — the full per-endpoint contract for everything above.
