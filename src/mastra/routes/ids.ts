/**
 * Shared validation for ids that arrive from public browser callers
 * (`visitor_id`, `thread_id`, `traceId`, `spanId`).
 */
export const isValidId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= 128 &&
  // eslint-disable-next-line no-control-regex
  !/[\x00-\x1f\x7f]/.test(value);
