// Intentional negative fixture, never included in application compilation.
const value = JSON.parse("{}");
// @ts-ignore
Promise.resolve(value);
export {};
