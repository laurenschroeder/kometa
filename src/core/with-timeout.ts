// Runs `work` with an upper time bound — shared by every network-backed
// extra (VIVERSE SDK calls, the Firestore comet counter) so a hung request
// can never leave anything waiting forever. Taking a thunk rather than a
// promise also turns a synchronous throw inside `work` into a rejection
// instead of letting it escape to the caller.
export function withTimeout<T>(work: () => T | Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    (async () => work())().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
