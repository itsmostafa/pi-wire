// Test-only ESM resolve hook: the extension sources import each other
// extensionless ("./types"), which pi's TS loader resolves but plain Node
// ESM does not. This hook appends ".ts" when extensionless resolution fails.
// Never used at runtime by the extension itself.
export async function resolve(specifier, context, next) {
    try {
        return await next(specifier, context);
    } catch (err) {
        if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
            return next(`${specifier}.ts`, context);
        }
        throw err;
    }
}
