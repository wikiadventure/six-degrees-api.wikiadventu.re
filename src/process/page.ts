import { langDb, max_group_per_request } from './../index';
import { parseQuote, SqlDumpParser } from '../utils/sql/parseDumpStream';
import type { DocumentCollection, EdgeCollection } from "arangojs/collection";
import type { Database } from 'arangojs';

export async function parsePageDump() {
    console.log("Create page collection");
    const page = langDb.collection<WikiPage>("page");
    try {
        await page.create().catch();
        page.ensureIndex({ type: "persistent", fields: ["title"]})
    } catch(e) {

    }
    console.log("Page collection created");
    console.log("page dump arango transfert started");
    const parser = new PageSqlDumpParser(langDb, page);
    await parser.process();
    await parser.sendPage();
    console.log("page dump arango transfert completed");
    console.log("Number of page : ",(await page.count()).count)


}

class PageSqlDumpParser extends SqlDumpParser {

    total_parsed = 0;
    params:WikiPage[] = [];
    db:Database;
    page:DocumentCollection<WikiPage> & EdgeCollection<WikiPage>;

    override async processChunk(s:string) {
        // console.log("chunck : ", s);
        const idIndex = s.indexOf(",");
        if (idIndex == -1 ) return;
        const id = parseInt(s.slice(0,idIndex));
        if (isNaN(id)) return;
        const namespaceIndex = s.indexOf(",",idIndex+1);
        if (namespaceIndex == -1 ) return;
        const namespace = parseInt(s.slice(idIndex+1,namespaceIndex));
        if (namespace != 0) return;
        if (s.slice(namespaceIndex+1, namespaceIndex+2) != "'") return;
        const [title, titleIndex] = parseQuote(s, namespaceIndex+2);
        const isRedirect = s.slice(titleIndex+2, titleIndex+3);
        if (isRedirect == "0") await this.addPage(id, title);
    }

    async addPage(id:number, title:string) {
        // console.log("add page : ", title);
        this.params.push({
            title,
            _key: id+""
        });
        if (this.params.length >= max_group_per_request) {
            this.stream.pause();
            await this.lastChunckPromise;
            this.lastChunckPromise = this.sendPage();
            this.params = [];
            this.stream.resume();
        }
        this.total_parsed++;
        if (this.total_parsed%10000 == 0) {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(`Page -> ${this.total_parsed} insert completed , Memory used : ${process.memoryUsage().heapUsed / 1024 / 1024} mo`);
        }
    }

    async sendPage() {
        await this.page.saveAll(this.params, {silent: true, overwriteMode: "replace"});
        return;
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