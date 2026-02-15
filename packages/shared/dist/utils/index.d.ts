export declare function isFirestoreTimestamp(data: unknown): data is {
    seconds: number;
    nanoseconds: number;
    toDate: () => Date;
};
