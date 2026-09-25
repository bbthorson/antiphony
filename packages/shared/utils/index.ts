/**
 * Type guard checking whether a value is a valid Date instance (not NaN).
 */
export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}