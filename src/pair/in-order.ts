/**
 * Wrap an async frame handler so relay frames are handled one at a time, in arrival order.
 *
 * `ws.on('message')` does not wait for an async handler. The phone sends its plain `hello` and,
 * when the user taps Pair, a sealed `ready`. If `ready` arrives while `hello` is still deriving
 * the session key, an unqueued handler sees no key yet and drops it, and login never finishes.
 */
export function inOrder<T>(handle: (frame: T) => Promise<void> | void): (frame: T) => void {
  let queue: Promise<void> = Promise.resolve();
  return (frame: T) => {
    queue = queue.then(() => handle(frame)).catch(() => {
      /* one bad frame must not stop the rest */
    });
  };
}
