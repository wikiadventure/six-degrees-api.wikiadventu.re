import { langDb, max_group_per_request } from './../index';
import { aql, Database } from "arangojs";
import { parseQuote, SqlDumpParser } from '../utils/sql/parseDumpStream';

export async function parseRedirectDump() {;

    console.log("Creating redirect collection");
    const redirect = langDb.collection<WikiRedirect>("redirect");
    try {
        await redirect.create().catch();
        redirect.ensureIndex({ type: "persistent", fields: ["title"]})
    } catch(e) {

    }
    console.log("Redirect collection created");
    console.log("Redirect dump arango transfert started");
    const parser = new RedirectSqlDumpParser(langDb);
    await parser.process();
    await parser.sendRedirect();
    console.log("Redirect dump arango transfert completed");
    console.log((await redirect.count()).count)

}

class RedirectSqlDumpParser extends SqlDumpParser {

    total_parsed = 0;
    params:WikiRedirect[] = [];
    db:Database;

    override async processChunk(s:string) {
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
        const [interwiki, interwikiIndex] = parseQuote(s, titleIndex+1);
        const [fragment, fragmentIndex] = parseQuote(s, interwikiIndex+1);
        if (interwiki != "") {
            // console.log(s);
            return
        }
        await this.addRedirect(id, title);
    }

    async addRedirect(id:number, title:string) {
        this.params.push({_key: id+"", to: title})
        if (this.params.length > max_group_per_request) {
            this.stream.pause();
            await this.lastChunckPromise;
            this.lastChunckPromise = this.sendRedirect();
            this.params = [];
            this.stream.resume();
        }
        this.total_parsed++;
        if (this.total_parsed%100_000 == 0) {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(`Redirect -> ${this.total_parsed} insert completed`);
        }
    }

    async sendRedirect() {
        this.params;
        await this.db.query(aql`
        FOR param IN ${this.params}
            INSERT param IN redirect OPTIONS { ignoreErrors: true }
        `)
        return;
    }

    constructor(db:Database) {
        super("redirect.sql.gz");
        this.db = db;
    }
}

type WikiPage = {
    title: string,
    _key: string // _key is now the page id
}

type WikiRedirect = {
    to: string,
    _key: string // _key is now the page id
}