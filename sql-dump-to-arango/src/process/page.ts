import { langDb, max_group_per_request } from './../index';
import { parseQuote, SqlDumpParser } from '../utils/sql/parseDumpStream';
import type { DocumentCollection, EdgeCollection } from "arangojs/collection";
import type { Database } from 'arangojs';
import { PassThrough, Transform, Writable } from 'node:stream';


export async function parsePageDump() {
    console.log("Create page collection");
    const page = langDb.collection<WikiPage>("page");
    try {
        await page.create().catch();
        await page.ensureIndex({ type: "persistent", fields: ["title"], unique: true, inBackground: true})
    } catch(e) {

    }
    // return
    console.log("Page collection created");
    console.log("page dump arango transfert started");
    const parser = new PageSqlDumpParser(langDb, page);
    await parser.process();
    // await parser.sendPage();
    console.log("page dump arango transfert completed");
    console.log("Number of page : ",(await page.count()).count)


}

export const pageMap = new Map<string,number>();
export const redirectMap = new Map<string,number>();

class PageSqlDumpParser extends SqlDumpParser<WikiPage> {

    // params:WikiPage[] = [];
    db:Database;
    page:DocumentCollection<WikiPage>;
    override type = "Page";
    uploadStream = new PassThrough();

    override processChunk(s:string) {
        // console.log("chunck : ", s);
        const idIndex = s.indexOf(",");
        // if (idIndex == -1 ) return;
        const id = parseInt(s.slice(0,idIndex),10);
        // if (isNaN(id)) { console.log("NaN Value: ", s); return;}
        const namespaceIndex = s.indexOf(",",idIndex+1);
        // if (namespaceIndex == -1 ) return;
        const namespace = s[idIndex+1];
        if (namespace != "0") return;
        // if (s[namespaceIndex+1] != "'") return;
        const [title, titleIndex] = parseQuote(s, namespaceIndex+1);
        const isRedirect = s[titleIndex+2];
        if (isRedirect == "0") {
            pageMap.set(title, id);
            return {
                title,
                _key: id+""
            }
        } else {
            redirectMap.set(title, id);
        }
        return;
    }

    override async processGroup(chunk:WikiPage[]): Promise<void> {
        await this.page.import(chunk, {
            onDuplicate: "ignore",
            waitForSync: false
            
        }).catch(e=>{});
    }

    override processStreamPipe(processStream: Transform, processComplete: (value: void | PromiseLike<void>) => void, resolve: (value: void | PromiseLike<void>) => void): void {
        processStream
            .pipe(
                new Writable({
                    objectMode: true,
                    // highWaterMark: max_group_per_request,
                    write: async (chunk, enc, next) => {
                        this.params.push(chunk);
                        if (this.params.length>=max_group_per_request) {
                            await this.lastChunckPromise;
                            this.lastChunckPromise = this.processGroup(this.params);
                            this.params = [];
                        }
                        next();
                    }
                })
            )
            .on("finish",async ()=>{
                await this.processGroup(this.params);
                processComplete();
                resolve();
            })
    }

    constructor(db:Database, page:DocumentCollection<WikiPage> & EdgeCollection<WikiPage>) {
        super("page.sql.gz");
        this.db = db;
        this.page = page;

    }
}

type WikiPage = {
    title: string,
    _key: string // _key is now the page id
}