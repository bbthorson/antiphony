export function isFirestoreTimestamp(data: unknown): data is { seconds: number; nanoseconds: number; toDate: () => Date } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'seconds' in data &&
    'nanoseconds' in data &&
    typeof data.seconds === 'number' &&
    typeof data.nanoseconds === 'number' &&
    'toDate' in data &&
    typeof data.toDate === 'function'
  );
}