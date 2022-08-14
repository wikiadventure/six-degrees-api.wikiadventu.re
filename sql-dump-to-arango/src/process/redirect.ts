import { langDb } from './../index';
import type { Database } from "arangojs";
import { parseQuote, SqlDumpParser } from '../utils/sql/parseDumpStream';
import { pageMap } from './page';

export async function parseRedirectDump() {;

    console.log("Creating redirect collection");
    // const redirect = langDb.collection<WikiRedirect>("redirect");
    // try {
    //     await redirect.create().catch();
    //     redirect.ensureIndex({ type: "persistent", fields: ["title"]})
    // } catch(e) {

    // }
    // return;
    console.log("Redirect collection created");
    console.log("Redirect dump arango transfert started");
    const parser = new RedirectSqlDumpParser(langDb);
    await parser.process();
    // await parser.sendRedirect();
    console.log("Redirect dump arango transfert completed");
    // console.log((await redirect.count()).count)

}

export const resolvedRedirectMap = new Map<number,number>();

class RedirectSqlDumpParser extends SqlDumpParser<void> {

    override type = "Redirect";
    // params:WikiRedirect[] = [];
    db:Database;

    override processChunk(s:string) {
        const idIndex = s.indexOf(",");
        // if (idIndex == -1 ) return;
        const id = parseInt(s.slice(0,idIndex),10);
        // if (isNaN(id)) return;
        const namespaceIndex = s.indexOf(",",idIndex+1);
        // if (namespaceIndex == -1 ) return;
        const namespace = s[idIndex+1];
        if (namespace != "0") return;
        // if (s[namespaceIndex+1] != "'") return;
        const [title, titleIndex] = parseQuote(s, namespaceIndex+1);
        const [interwiki, interwikiIndex] = parseQuote(s, titleIndex+1);//TODO : optimize we don't need to parse the whole div
        // const [fragment, fragmentIndex] = parseQuote(s, interwikiIndex+1);
        if (interwiki != "") return;
        this.addRedirect(id, title);
        return;
    }

    addRedirect(id:number, title:string) {
        const toId = pageMap.get(title);
        if (toId!=null) resolvedRedirectMap.set(id,toId);
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