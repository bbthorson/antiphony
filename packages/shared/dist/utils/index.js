"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFirestoreTimestamp = isFirestoreTimestamp;
function isFirestoreTimestamp(data) {
    return (typeof data === 'object' &&
        data !== null &&
        'seconds' in data &&
        'nanoseconds' in data &&
        typeof data.seconds === 'number' &&
        typeof data.nanoseconds === 'number' &&
        'toDate' in data &&
        typeof data.toDate === 'function');
}
