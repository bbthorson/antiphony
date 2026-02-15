function makeSerializable(data: unknown): unknown {
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }

  // Handle Firestore Timestamps and JS Date objects
  if (data && typeof data === 'object' && 'toDate' in data && typeof (data as { toDate: () => Date }).toDate === 'function') {
    return (data as { toDate: () => Date }).toDate().toISOString();
  }
  if (data instanceof Date) {
    return data.toISOString();
  }

  if (Array.isArray(data)) {
    return data.map(makeSerializable);
  }

  // Handle plain objects by iterating over their keys
  const newObj: Record<string, unknown> = {};
  for (const key in data as Record<string, unknown>) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      newObj[key] = makeSerializable((data as Record<string, unknown>)[key]);
    }
  }
  return newObj;
}

export { makeSerializable };