import { langDb, max_group_per_request } from './../index';
import { aql, CollectionType, Database } from "arangojs";
import { parseQuote, SqlDumpParser } from '../utils/sql/parseDumpStream';

export async function parsePageLinksDump() {
    console.log("Creating links collection");
    const links = langDb.collection<{}>("links");
    
    try {
        await links.create({type: CollectionType.EDGE_COLLECTION}).catch();
        links.ensureIndex({ type: "persistent", fields: [ "_from", "_to" ], unique: true });
        // await links.create().catch();
    } catch(e) {
        
    }
    console.log("Links collection created");
    console.log("pagelinks dump arango transfert started");
    const parser = new PageLinkSqlDumpParser(langDb);
    await parser.process();
    await parser.sendPageLinks();
    console.log("pagelinks dump arango transfert completed");
    console.log("Number of links : ",(await links.count()).count)


}

class PageLinkSqlDumpParser extends SqlDumpParser {

    total_parsed = 0;
    params:{fromId:string, toTitle:string}[] = [];
    db:Database;

    override async processChunk(s:string) {
        const fromIndex = s.indexOf(",");
        if (fromIndex == -1 ) return;
        const from = 
        parseInt(s.slice(0,fromIndex));
        if (isNaN(from)) return;
        const namespaceIndex = s.indexOf(",",fromIndex+1);
        if (namespaceIndex == -1 ) return;
        const namespace = parseInt(s.slice(fromIndex+1,namespaceIndex));
        if (namespace != 0) return;
        if (s.slice(namespaceIndex+1, namespaceIndex+2) != "'") return;
        const [title, titleIndex] = parseQuote(s, namespaceIndex+2);
        const fromNamespace = parseInt(s.slice(titleIndex));
        if (fromNamespace != 0) return;
        await this.addPageLink(from+"", title);
    }

    async addPageLink(fromId:string, toTitle:string) {
        this.params.push({fromId, toTitle});
        if (this.params.length >= max_group_per_request) {
            this.stream.pause();
            await this.lastChunckPromise;
            this.lastChunckPromise = this.sendPageLinks();
            this.params = [];
            this.stream.resume();
        }
        this.total_parsed++;
        if (this.total_parsed%100_000 == 0) {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(`Pagelink -> ${this.total_parsed} insert completed`);
        }
    }

    async sendPageLinks() {
        this.params;
        await this.db.query(aql`
            FOR param IN ${this.params}
                LET redirectTo = (
                    FOR r IN redirect
                        FILTER r.title == param.toTitle
                        LIMIT 1
                        RETURN r.to
                )
                LET pageId = redirectTo[0] == null ? (
                    FOR p IN page
                        FILTER p.title == param.toTitle
                        LIMIT 1
                        RETURN p._key
                ) : redirectTo
                INSERT {
                    _from: CONCAT("page/", param.fromId),
                    _to: CONCAT("page/", pageId[0])
                } IN links OPTIONS { ignoreErrors: true }
        `);
        return;
    }

    constructor(db:Database) {
        super("pagelinks.sql.gz");
        this.db = db;
    }
}
