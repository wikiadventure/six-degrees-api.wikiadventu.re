import 'dotenv/config';
import { parsePageDump } from "@process/page";
import { parsePageLinksDump } from "@process/pageLinks";
import { parseRedirectDump } from "@process/redirect";
import { Database } from 'arangojs';

export const max_group_per_request = parseInt(process.env['MAX_GROUP_PER_REQUEST'] || "20000");

export const lang = process.env['WIKI_LANG'];
const DB_URL = "tcp://127.0.0.1:8529";
const DB_USERNAME = process.env['DB_USERNAME'];
const DB_PASSWORD = process.env['DB_PASSWORD'];

export const db = new Database(DB_USERNAME != null ? {
    url: DB_URL,
    auth: {
        username: DB_USERNAME,
        password: DB_PASSWORD
    }
} : {
    url: DB_URL
});

export var langDb:Database;

async function main() {
    try {
        await db.createDatabase(`${lang}wiki`);
    } catch(e) {
            
    }
    langDb = db.database(`${lang}wiki`);
    console.log("Start Parsing dump to arango db");
    await parsePageDump();
    await parseRedirectDump();
    await parsePageLinksDump();
    
    console.log("Parsing completed !");
}

main();

export  {}