/**
 * Throwaway resolver hook for running the smoke test without bun: Node's
 * type-stripping needs the extensionless relative imports in this project
 * (`./src/anchors`) mapped to their `.ts` files.
 *
 *   node --experimental-strip-types --experimental-loader ./work/ts-resolve.mjs smoke-test.ts
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      /* fall through to the original specifier */
    }
  }
  return next(specifier, context);
}
