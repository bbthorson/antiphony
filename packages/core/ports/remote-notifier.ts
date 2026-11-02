/**
 * RemoteNotifierPort — telling the tenant what the deletion sweep did to a
 * remote post (specs/audio-service-mode.md §6, §8). Best-effort, like the
 * stage-settled webhook: the row is already changed when this fires, so a
 * dropped notice is latency, never a lost result.
 *
 *  - `remote.gone`: the source record was deleted, so Antiphony's copy and
 *    everything derived from it were removed.
 *  - `remote.changed`: the source record was edited; `cid` is its new CID.
 */
export interface RemotePostEvent {
    type: 'remote.gone' | 'remote.changed';
    originAppId: string;
    uri: string;
    /** The record's CID after the change; absent on `remote.gone`. */
    cid?: string;
    occurredAt: string;
}

export interface RemoteNotifierPort {
    notifyRemote(event: RemotePostEvent): Promise<void>;
}

export const noopRemoteNotifier: RemoteNotifierPort = {
    async notifyRemote(): Promise<void> {},
};
