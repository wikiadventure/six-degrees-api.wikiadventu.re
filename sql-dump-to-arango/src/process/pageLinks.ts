import { langDb, max_group_per_request } from './../index';
import { aql, CollectionType, Database } from "arangojs";
import { parseQuote, SqlDumpParser } from '../utils/sql/parseDumpStream';
import type { EdgeCollection } from 'arangojs/collection';
import { redirectMap, pageMap } from './page';
import { resolvedRedirectMap } from './redirect';
import { createWriteStream, WriteStream } from 'node:fs';
import type { Transform } from 'node:stream';

export async function parsePageLinksDump() {
    console.log("Creating links collection");
    const links = langDb.collection<{}>("links");
    
    try {
        await links.create({type: CollectionType.EDGE_COLLECTION}).catch();
        await links.ensureIndex({ type: "persistent", fields: [ "_from", "_to" ], unique: true, inBackground: true});
        // await links.create().catch();
    } catch(e) {
        
    }
    console.log("Links collection created");
    console.log("pagelinks dump arango transfert started");
    const parser = new PageLinkSqlDumpParser(langDb, links);
    await parser.process();
    // await parser.sendPageLinks();
    console.log("pagelinks dump arango transfert completed");
    console.log("Number of links : ",(await links.count()).count)


}
class PageLinkSqlDumpParser extends SqlDumpParser<string> {

    // override params:{_from:string, _to:string}[] = [];
    db:Database;
    links:EdgeCollection;
    override type = "links";
    csv:WriteStream;

    override processChunk(s:string) {
        const fromIndex = s.indexOf(",");
        // if (fromIndex == -1 ) return;
        const _from = s.slice(0,fromIndex);
        // if (isNaN(from)) return;
        const namespaceIndex = fromIndex+3;
        // if (namespaceIndex == -1 ) return;
        const namespace = s[fromIndex+1];
        if (namespace != "0") return;
        // if (s[namespaceIndex+1] != "'") return;
        const [title, titleIndex] = parseQuote(s, namespaceIndex);
        const fromNamespace = s[titleIndex+2];
        if (fromNamespace != "0") return;
        const redirectId = redirectMap.get(title);
        const _to = redirectId != null ? resolvedRedirectMap.get(redirectId) : pageMap.get(title);
        if (_to == null) return;
        return `${_from},${_to}\n`;
    }

    override async processGroup(chunk:string[]): Promise<void> {
        this.links.import(chunk, {
            fromPrefix: "page/",
            toPrefix: "page/",
            onDuplicate: "ignore",
            waitForSync: false
            
        }).catch(e=>{console.log("import error : ", e)});
        // if (t == null) return;
        // console.log(t==null ? "error :( " : t);
    }

    override processStreamPipe(processStream: Transform, processComplete: (value: void | PromiseLike<void>) => void, resolve: (value: void | PromiseLike<void>) => void): void {
        // processStream
        // .pipe(
        //     new Writable({
        //         objectMode: true,
        //         highWaterMark: max_group_per_request,
        //         write: async (chunk, enc, next) => {
        //             this.params.push(chunk);
        //             if (this.params.length>=max_group_per_request) {
        //                 await this.lastChunckPromise;
        //                 this.lastChunckPromise = this.processGroup(this.params);
        //                 this.params = [];
        //             }
        //             next();
        //         }
        //     })
        // )
        // .on("finish",async ()=>{
        //     await this.processGroup(this.params);
        //     processComplete();
        //     resolve();
        // })
        processStream
            .pipe(this.csv)
            .on("finish",async ()=>{
                // this.csv.write("\r\n");
                processComplete();
                resolve();
            })
    }

    constructor(db:Database, links:EdgeCollection) {
        super("pagelinks.sql.gz");
        this.db = db;
        this.links = links;
        this.csv = createWriteStream("importLinks.csv", {flags:'a'});
        this.csv.write("_from,_to\n");
    }
}
