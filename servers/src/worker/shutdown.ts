/** Adapt async shutdown to a synchronous signal callback; report rejected cleanup. */
export function shutdownHandler(stop: () => Promise<void>, onError: (error: unknown) => void): () => void {
  return () => { void stop().catch(onError); };
}
