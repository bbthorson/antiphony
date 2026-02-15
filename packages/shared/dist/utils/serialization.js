"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeSerializable = makeSerializable;
function makeSerializable(data) {
    if (data === null || data === undefined || typeof data !== 'object') {
        return data;
    }
    // Handle Firestore Timestamps and JS Date objects
    if (data && typeof data === 'object' && 'toDate' in data && typeof data.toDate === 'function') {
        return data.toDate().toISOString();
    }
    if (data instanceof Date) {
        return data.toISOString();
    }
    if (Array.isArray(data)) {
        return data.map(makeSerializable);
    }
    // Handle plain objects by iterating over their keys
    const newObj = {};
    for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            newObj[key] = makeSerializable(data[key]);
        }
    }
    return newObj;
}
