/**
 * RemoteNotifierPort — telling the tenant what the deletion sweep did to a
 * remote post (specs/audio-service-mode.md §6, §8). Best-effort, like the
 * stage-settled webhook: the row is already changed when this fires, so a
 * dropped notice is latency, never a lost result.
 *
 *  - `remote.gone`: the source record was deleted, so Antiphony's copy and
 *    everything derived from it were removed.
 *  - `remote.changed`: the source record was edited; `cid` is its new CID.
 *  - `remote.recheck_requested`: rows in a space are due for a recheck, which
 *    takes a fresh delegation (Phase C). `uri` and `space` are the space's
 *    URI; the tenant answers with `POST /api/v1/remote-posts/recheck`.
 */
export interface RemotePostEvent {
    type: 'remote.gone' | 'remote.changed' | 'remote.recheck_requested';
    originAppId: string;
    /** The record's URI, or for `remote.recheck_requested` the space's. */
    uri: string;
    /** The record's CID after the change; only on `remote.changed`. */
    cid?: string;
    /** The space's URI; only on `remote.recheck_requested`. */
    space?: string;
    occurredAt: string;
}

export interface RemoteNotifierPort {
    notifyRemote(event: RemotePostEvent): Promise<void>;
}

export const noopRemoteNotifier: RemoteNotifierPort = {
    async notifyRemote(): Promise<void> {},
};
