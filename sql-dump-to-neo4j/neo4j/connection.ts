import { driver } from "neo4j-driver";
import { setTimeout } from "node:timers/promises";
import type { Edge, WikiPage } from "../index.js";

export const db = driver("bolt://localhost:7687");

const isUp = new Promise<void>(async (res,_) => {
    console.log(`Waiting Neo4j...`);
    const startTime = Date.now();
    do {    
        try {
            await db.getServerInfo();
            console.log(`Neo4j up (${Date.now() - startTime}ms)`);
            res();
            return;
        } catch(e) {
        }
        await setTimeout(50);
    } while (true);
});

await isUp;

export async function initNeo4jIndex() {
    return Promise.all([
        db.session().run(`CREATE INDEX index_wiki_page_id FOR (n:WikiPage) ON (n.id);`),
        db.session().run(`CREATE INDEX index_wiki_page_title FOR (n:WikiPage) ON (n.title);`),
    ])
}

const insertPageQuery = 
`WITH $batch AS nodes
UNWIND nodes AS node
CREATE(:WikiPage{id:node.id,title:node.title,isRedirect:node.isRedirect})`;

export async function insertPages(batch:WikiPage[]) {
    return db.session().executeWrite(tx=>tx.run(insertPageQuery, {batch}))
}

const insertRedirectQuery = 
`WITH $batch AS nodes
UNWIND nodes AS node
MATCH (a:WikiPage {id: node._from}), (b:WikiPage {id: node._to}) CREATE (a)-[:WikiRedirect]->(b)`;

export async function insertRedirects(batch:Edge[]) {
    return db.session().executeWrite(tx=>tx.run(insertRedirectQuery, {batch}))
}

const insertLinkQuery = 
`WITH $batch AS nodes
UNWIND nodes AS node
MATCH (a:WikiPage {id: node._from}), (b:WikiPage {id: node._to}) CREATE (a)-[:WikiLink]->(b)`;

export async function insertLinks(batch:Edge[]) {
    return db.session().executeWrite(tx=>tx.run(insertLinkQuery, {batch}))
}
