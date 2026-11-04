/**
 * Vite's `import.meta.glob`, which Vitest compiles into a map of lazy imports. Declared here
 * because these tests use only that part of Vite's client types.
 */
interface ImportMeta {
  glob(patterns: string | ReadonlyArray<string>): Record<string, () => Promise<object>>;
}
