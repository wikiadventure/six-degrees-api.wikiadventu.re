import { RecordId, Surreal } from 'surrealdb';
import type { Edge, WikiPage } from "../index.js";
import { env } from '../env.js';

export const db = new Surreal();

async function main() {
    await db.connect(env.SURREAL_URL);
    await db.use({ namespace: env.SURREAL_NS, database: env.SURREAL_DB });
    await db.signin({
        username: env.SURREAL_USER,
        password: env.SURREAL_PASS,
    });
}

await main();

export async function initSurrealIndex() {
    await db.query(`DEFINE TABLE WikiPage SCHEMALESS;`);
    return Promise.all([
        db.query(`DEFINE INDEX index_wiki_page_id ON TABLE WikiPage COLUMNS id;`),
        db.query(`DEFINE INDEX index_wiki_page_title ON TABLE WikiPage COLUMNS title;`),
    ])
}

export async function insertPages(batch:WikiPage[]) {
    return db.insert('WikiPage', batch);
}

export async function insertRedirects(batch:Edge[]) {
    return db.insertRelation("WikiRedirect", batch.map(e=>({
        in:  new RecordId('WikiPage', e._from),
        out:  new RecordId('WikiPage', e._to),
    })));
}

export async function insertLinks(batch:Edge[]) {
    return db.insertRelation("WikiLink", batch.map(e=>({
        in:  new RecordId('WikiPage', e._from),
        out:  new RecordId('WikiPage', e._to),
    })))
}

