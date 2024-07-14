import { parseDumpContent, sqlDumpStream, sqlDumpStreamFromWeb } from "./parser/dumpParser.js";
import { db, initMemgraphIndex, insertLinks, insertPages, insertRedirects } from "./memgraph/connection.js";
import { createDumpProgressLogger } from "./logger/dumpProgress.js";
import LargeMapImport from "large-map";
const LargeMap = LargeMapImport as unknown as typeof LargeMapImport.default;
// import { CollectionType } from "arangojs/collection.js";
import { env } from "./env.js";

export type WikiPage = {
    title: string,
    id: number // _key is now the page id
    isRedirect: boolean
}

export type Edge = {
    _from:number,
    _to:number
}

await initMemgraphIndex();

// map a title to an id
const pageMap = new LargeMap<string, [number,boolean]>();

async function parseAndLoadPage() {


    const { info, stream } = await sqlDumpStream("page");
    let previousBatchPromise = Promise.resolve() as Promise<any>;
    let count = 0;
    let nextBatch:WikiPage[] = [];
    const { log } = createDumpProgressLogger(info.size, "Page");
    
    for await (const [page_id, page_title, page_namespace, page_is_redirect] of parseDumpContent(stream, ["page_id","page_title", "page_namespace","page_is_redirect"] as const)) {
        const isRedirect = page_is_redirect == "1";
        if (page_namespace != "0") continue;
        const id = Number(page_id);
        pageMap.set(page_title,[id,isRedirect]);
        nextBatch.push({id, title:page_title, isRedirect});
        count++;

        if (count % 32_768 == 0) {
            
            await previousBatchPromise;
            /**
             * The call of insert is not instant due to the neo4j driver lib
             * so we need to put the current batch into in it's own variable
             * and push the new values into the next batch to avoid inserting some
             * values mutliple time
             */
            const batch = nextBatch;
            nextBatch = [];

            previousBatchPromise = insertPages(batch);
            // previousBatchPromise = Promise.resolve() as Promise<any>;

            if (count % 32_768*8 == 0) {
                log(info.bytesRead, count);
            }
        }

    }
    await previousBatchPromise;
    const batch = nextBatch;
    nextBatch = [];
    await insertPages(batch);
}

const redirectMap = new LargeMap<number,string>();
const toResolve:[number, string][] = [];

async function parseAndLoadRedirect() {

    const { info, stream } = await sqlDumpStream("redirect");
    let previousBatchPromise = Promise.resolve() as Promise<any>;
    let count = 0;
    let nextBatch:Edge[] = [];
    const { log } = createDumpProgressLogger(info.size, "Redirect ");
    for await (const [rd_from, rd_namespace, rd_title, rd_interwiki, rd_fragment] of parseDumpContent(stream, ["rd_from","rd_namespace","rd_title","rd_interwiki","rd_fragment"] as const)) {
        if (rd_namespace != "0") continue;
        const _toIsRedirect = pageMap.get(rd_title);
        // the redirect lead to a page that does not exist ( most likely  it's not in the article namespace)
        if (_toIsRedirect == null) {
            continue;
        }
        const _from = Number(rd_from);
        const [_to, isRedirect] = _toIsRedirect;
        // The redirect lead to another redirect that need to be resolved
        if (isRedirect) {
            toResolve.push([_from,rd_title]);
            continue;
         // The redirect lead to a valid page
        } else {
            redirectMap.set(_from, rd_title);
            nextBatch.push({_from, _to});
            count++;
        }


        if (count % 32_768 == 0) {
            await previousBatchPromise;

            const batch = nextBatch;
            nextBatch = [];

            previousBatchPromise = insertRedirects(batch);
            // previousBatchPromise = Promise.resolve() as Promise<any>;

            if (count % 32_768*8 == 0) {
                log(info.bytesRead, count);
            }
        }

    }

    for (const [_from, _to_title] of toResolve) {
        const _to = resolveRedirect(_to_title);
        if (_to==null) return 
        nextBatch.push({_from, _to});
            
        count++;
        if (count % 32_768 == 0) {
            await previousBatchPromise;

            const batch = nextBatch;
            nextBatch = [];

            previousBatchPromise = insertRedirects(batch);
            // previousBatchPromise = Promise.resolve() as Promise<any>;

            if (count % 32_768*8 == 0) {
                log(info.bytesRead, count);
            }
        }

    }

    await previousBatchPromise;

    const batch = nextBatch;
    nextBatch = [];

    await insertRedirects(batch);
    log(info.bytesRead, count);
    nextBatch = [];
}


const linkTargetMap = new LargeMap<number, string>();

async function parseLinkTarget() {
    const { info, stream } = await sqlDumpStream("linktarget");
    let count = 0;
    const { log } = createDumpProgressLogger(info.size, "Linktarget");
    
    for await (const [lt_id,lt_namespace, lt_title] of parseDumpContent(stream, ["lt_id","lt_namespace", "lt_title" ] as const)) {
        if (lt_namespace != "0") continue;
        linkTargetMap.set(Number(lt_id), lt_title);
        count++;

        if (count % 32_768*8 == 0) {
            log(info.bytesRead, count);
        }

    }
}


async function parseAndLoadPageLinks() {

    const { info, stream } = await sqlDumpStream("pagelinks");
    let previousBatchPromise = Promise.resolve() as Promise<any>;
    let count = 0;
    let nextBatch:Edge[] = [];
    const { log } = createDumpProgressLogger(info.size, "PageLinks ");
    for await (const [pl_from, pl_namespace, pl_title, pl_from_namespace] of parseDumpContent(stream, ["pl_from","pl_namespace","pl_title","pl_from_namespace"] as const)) {
        if (pl_namespace != "0" || pl_from_namespace != "0") continue;
        const _toIsRedirect = pageMap.get(pl_title);
        if (_toIsRedirect == null) {
            continue;
        }
        const _from = Number(pl_from);
        const [_to, isRedirect] = _toIsRedirect;
        // The link lead to a redirect that need to be resolve;
        if (isRedirect) {
            const _to_resolved = resolveRedirect(redirectMap.get(_to));
            if (_to_resolved == null) {
                continue;
            }
            nextBatch.push({_from, _to: _to_resolved});
            count++;
        // The link resolve to a valid page
        } else {
            nextBatch.push({_from, _to: _toIsRedirect[0]});
            count++;
        }


        if (count % 16_384 == 0) {
            await previousBatchPromise;

            const batch = nextBatch;
            nextBatch = [];

            previousBatchPromise = insertLinks(batch);
            // previousBatchPromise = Promise.resolve() as Promise<any>;
            if (count % 32_768 == 0) {
                log(info.bytesRead, count);
            }
        }

    }
    await previousBatchPromise;

    const batch = nextBatch;
    nextBatch = [];

    await insertLinks(batch);
    log(info.bytesRead, count);
    nextBatch = [];
}

async function parseAndLoadPageLinksWithLinkTarget() {
    await parseLinkTarget();

    const { info, stream } = await sqlDumpStream("pagelinks");
    let previousBatchPromise = Promise.resolve() as Promise<any>;
    let count = 0;
    let nextBatch:Edge[] = [];
    const { log } = createDumpProgressLogger(info.size, "PageLinks ");
    for await (const [pl_from, pl_from_namespace, pl_target_id] of parseDumpContent(stream, ["pl_from", "pl_from_namespace", "pl_target_id"] as const)) {
        const toTitle = linkTargetMap.get(Number(pl_target_id));
        if (toTitle == null) continue;
        const _toIsRedirect = pageMap.get(toTitle);
        if (_toIsRedirect == null) {
            continue;
        }
        const _from = Number(pl_from);
        const [_to, isRedirect] = _toIsRedirect;
        // The link lead to a redirect that need to be resolve;
        if (isRedirect) {
            const _to_resolved = resolveRedirect(redirectMap.get(_to));
            if (_to_resolved == null) {
                continue;
            }
            nextBatch.push({_from, _to: _to_resolved});
            count++;
        // The link resolve to a valid page
        } else {
            nextBatch.push({_from, _to});
            count++;
        }


        if (count % 16_384 == 0) {
            await previousBatchPromise;

            const batch = nextBatch;
            nextBatch = [];

            previousBatchPromise = insertLinks(batch);
            // previousBatchPromise = Promise.resolve() as Promise<any>;
            if (count % 16_384 == 0) {
                log(info.bytesRead, count);
            }
        }

    }
    await previousBatchPromise;

    const batch = nextBatch;
    nextBatch = [];

    await insertLinks(batch);
    log(info.bytesRead, count);
    nextBatch = [];
}

function resolveRedirect(pageTitle):null|number {
    let n = 0;
    if (pageTitle == null) return null;
    let lastTitle = redirectMap.get(pageMap.get(pageTitle)[0]);
    while (n<10) {
        const _toIsRedirect = pageMap.get(lastTitle);
        if (_toIsRedirect == null) {
            return null;
        }
        const [id,isRedirect] = _toIsRedirect;
        if (!isRedirect) {
            return id;
        }
        lastTitle = redirectMap.get(id);
        n++;
    }
    return null;
}
await parseAndLoadPage();
await parseAndLoadRedirect();
if (["fr", "eo", "en"].includes(env.WIKI_LANG)) {
    await parseAndLoadPageLinksWithLinkTarget();
} else {
    await parseAndLoadPageLinks();
}
console.log("Create snapshot...");
await db.session().run(`CREATE SNAPSHOT;`);
console.log("Snapshot complete...");

console.log("finished");

process.exit(0);
