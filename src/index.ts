import 'dotenv/config';
import { parsePageDump } from "@process/page";
import { parsePageLinksDump } from "@process/pageLinks";
import { parseRedirectDump } from "@process/redirect";
import { Database } from 'arangojs';

export const max_group_per_request = parseInt(process.env['MAX_GROUP_PER_REQUEST'] || "20000");
const args = process.argv.slice(2);

export const lang = args[0] || "en";
const DB_URL = process.env['DB_URL'];
const DB_USERNAME = process.env['DB_USERNAME'];
const DB_PASSWORD = process.env['DB_PASSWORD'];

if (DB_URL == null || DB_USERNAME == null || DB_PASSWORD == null) throw "Fill env with database url, username and password!";

export const db = new Database({
    url: DB_URL,
    auth: {
        username: DB_USERNAME,
        password: DB_PASSWORD
    }
});

export const langDb = db.database(`${lang}wiki`);

async function main() {
    await parsePageDump();
    await parseRedirectDump();
    await parsePageLinksDump();
}

main();


export  {}