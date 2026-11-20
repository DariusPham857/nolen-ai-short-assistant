/** Validate runtime secrets before the server can report ready; build requires none. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runtimeConfig } = await import('@nolen/server/runtime');
    runtimeConfig();
  }
}
