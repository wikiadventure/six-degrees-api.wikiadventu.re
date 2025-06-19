import z, { ZodError } from 'zod';

const envSchema = z.object({
    USE_CACHE: z.coerce.number().default(1),
    WIKI_LANG: z.string().min(1).default("fr"),
}).catchall(z.string());


/**
 * We create an env object that must satisfie the schema above
 * We exit the process if env lack any field or have incorrect field
 * It print a nice message in the console to guide you
 * to fix those env error
 */
export const env = 
(() => {
    try {
        return envSchema.parse(process.env);
    } catch (error) {
        const e = error as unknown as ZodError;
        console.error(
            'Env config is incorrect: \n',
            e.errors.map(v=>` - ${v.path[0]} field ${v.message}`).join('\n'),
            '\nMake sure to fill the env with all the required fields.'
        );
        process.exit(1);
    }
})();

