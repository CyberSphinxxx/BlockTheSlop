/** Minimal Result type for fallible operations without exceptions. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Run a function, catching expected failures into a Result. */
export function attempt<T>(fn: () => T): Result<T, unknown> {
  try {
    return ok(fn());
  } catch (error) {
    return err(error);
  }
}

/** Run an async function, catching expected failures into a Result. */
export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T, unknown>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error);
  }
}
