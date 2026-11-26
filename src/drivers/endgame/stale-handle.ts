/**
 * WebHID rejects writes on a handle that went stale (sleep/resume, USB hiccup,
 * an earlier page) with a NetworkError ("Failed to write the feature report")
 * or an InvalidStateError (device closed). Anything else (a TypeError from bad
 * arguments, a driver Error) is not a handle problem and must not trigger a
 * close/reopen/resend.
 */
export function isStaleHandleError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "NetworkError" || name === "InvalidStateError";
}
