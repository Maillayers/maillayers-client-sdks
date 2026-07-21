export type HostCallbackResult<T> =
  | { ok: true; value: T }
  | { ok: false; missing: boolean };

/**
 * The single boundary for invoking untrusted host callbacks. It never throws or
 * rejects, including for synchronous throws, rejected promises, proxy apply traps,
 * and hostile thenables.
 */
export async function invokeHostCallback<TArgs extends readonly unknown[], TResult>(
  callback: ((...args: TArgs) => TResult | PromiseLike<TResult>) | undefined,
  args: TArgs,
): Promise<HostCallbackResult<TResult>> {
  if (typeof callback !== 'function') return { ok: false, missing: true };
  try {
    return { ok: true, value: await callback(...args) };
  } catch {
    return { ok: false, missing: false };
  }
}
