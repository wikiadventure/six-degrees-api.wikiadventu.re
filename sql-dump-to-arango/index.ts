import { parseDumpContent, sqlDumpStreamFromWeb } from "./parser/dumpParser.js";
import { initLangDatabase, insertLinks, insertPages, insertRedirects } from "./arango/connection.js";
import { createDumpProgressLogger } from "./logger/dumpProgress.js";
import { CollectionType } from "arangojs/collection.js";

export type WikiPage = {
    title: string,
    _key: string // _key is now the page id
    isRedirect: boolean
}

export type Edge = {
    _from:string,
    _to:string
}

const langDb = await initLangDatabase();
// map a title to an id
const pageMap = new Map<string, [string,boolean]>();

async function parseAndLoadPage() {

    const page = langDb.collection<WikiPage>("page");
    try {
        await page.create();
        await page.ensureIndex({ type: "persistent", fields: ["title"], unique: true, inBackground: true});
    } catch(e) {}

    const { info, stream } = await sqlDumpStreamFromWeb("page");
    let previousBatchPromise = Promise.resolve() as Promise<any>;
    let count = 0;
    let nextBatch:WikiPage[] = [];
    const { log } = createDumpProgressLogger(info.size, "Page");
    
    for await (const values of parseDumpContent(stream, ["page_id","page_title", "page_namespace","page_is_redirect"] as const)) {
        const isRedirect = values[3] == "1";
        if (values[2] != "0") continue;
        // pageMap.set(values[1],values[0]);
        pageMap.set(values[1],[values[0],isRedirect]);
        nextBatch.push({_key: values[0], title:values[1], isRedirect});
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

            previousBatchPromise = insertPages(batch, page);
            // previousBatchPromise = Promise.resolve() as Promise<any>;

            if (count % 32_768*8 == 0) {
                log(info.bytesRead, count);
            }
        }

    }
    await previousBatchPromise;
    const batch = nextBatch;
    nextBatch = [];
    await insertPages(batch, page);
}

const redirectMap = new Map<string,string>();
const toResolve:[string, string][] = [];

async function parseAndLoadRedirect() {

    const redirect = langDb.collection<{}>("redirect");
    try {
        await redirect.create({type: CollectionType.EDGE_COLLECTION}).catch();
        await redirect.ensureIndex({ type: "persistent", fields: [ "_from", "_to" ], unique: true, inBackground: true}).catch();
    } catch(e) {}


    const { info, stream } = await sqlDumpStreamFromWeb("redirect");
    let previousBatchPromise = Promise.resolve() as Promise<any>;
    let count = 0;
    let nextBatch:{_from:string,_to:string}[] = [];
    const { log } = createDumpProgressLogger(info.size, "Redirect ");
    for await (const values of parseDumpContent(stream, ["rd_from","rd_namespace","rd_title","rd_interwiki","rd_fragment"] as const)) {
        if (values[1] != "0") continue;
        const _toIsRedirect = pageMap.get(values[2]);
        // the redirect lead to a page that does not exist ( most likely  it's not in the article namespace)
        if (_toIsRedirect == null) {
            continue;
        }
        // The redirect lead to another redirect that need to be resolved
        if (_toIsRedirect[1]) {
            toResolve.push([values[0],values[2]]);
            continue;
         // The redirect lead to a valid page
        } else {
            nextBatch.push({_from:values[0],_to:_toIsRedirect[0]});
            count++;
        }


        if (count % 4096 == 0) {
            await previousBatchPromise;

            const batch = nextBatch;
            nextBatch = [];

            previousBatchPromise = insertRedirects(batch, redirect);
            // previousBatchPromise = Promise.resolve() as Promise<any>;

            if (count % 16_384 == 0) {
                log(info.bytesRead, count);
            }
        }

    }

    for (const r of toResolve) {
        const id = resolveRedirect(r[1]);
        if (id==null) return 
        nextBatch.push({_from:r[0],_to:id});
            
        count++;
        if (count % 4096 == 0) {
            await previousBatchPromise;

            const batch = nextBatch;
            nextBatch = [];

            previousBatchPromise = insertRedirects(batch, redirect);
            // previousBatchPromise = Promise.resolve() as Promise<any>;

            if (count % 16_384 == 0) {
                log(info.bytesRead, count);
            }
        }

    }

    await previousBatchPromise;

    const batch = nextBatch;
    nextBatch = [];

    await insertRedirects(batch, redirect);
    log(info.bytesRead, count);
    nextBatch = [];
}


async function parseAndLoadPageLinks() {

    const link = langDb.collection<{}>("link");

    try {
        await link.create({type: CollectionType.EDGE_COLLECTION}).catch();
        await link.ensureIndex({ type: "persistent", fields: [ "_from", "_to" ], unique: true, inBackground: true}).catch();
    } catch(e) {}

    const { info, stream } = await sqlDumpStreamFromWeb("pagelinks");
    let previousBatchPromise = Promise.resolve() as Promise<any>;
    let count = 0;
    let nextBatch:{_from:string,_to:string}[] = [];
    const { log } = createDumpProgressLogger(info.size, "PageLinks ");
    for await (const values of parseDumpContent(stream, ["pl_from","pl_namespace","pl_title","pl_from_namespace"] as const)) {
        if (values[1] != "0" || values[3] != "0") continue;
        const _toIsRedirect = pageMap.get(values[2]);
        if (_toIsRedirect == null) {
            continue;
        }
        // The link lead to a redirect that need to be resolve;
        if (_toIsRedirect[1]) {
            const resolvedId = resolveRedirect(redirectMap.get(_toIsRedirect[0]));
            if (resolvedId == null) {
                continue;
            }
            nextBatch.push({_from: values[0], _to: resolvedId});
            count++;
        // The link resolve to a valid page
        } else {
            nextBatch.push({_from: values[0], _to: _toIsRedirect[0]});
            count++;
        }


        if (count % 4096 == 0) {
            await previousBatchPromise;

            const batch = nextBatch;
            nextBatch = [];

            previousBatchPromise = insertLinks(batch, link);
            // previousBatchPromise = Promise.resolve() as Promise<any>;
            if (count % 16_384 == 0) {
                log(info.bytesRead, count);
            }
        }

    }
    await previousBatchPromise;

    const batch = nextBatch;
    nextBatch = [];

    await insertLinks(batch, link);
    log(info.bytesRead, count);
    nextBatch = [];
}

function resolveRedirect(pageTitle):null|string {
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
await parseAndLoadPageLinks();
console.log("finished");

process.exit(0);
