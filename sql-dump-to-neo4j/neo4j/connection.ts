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

const insertPageApocIterateQuery = 
`CALL apoc.periodic.iterate(
    "UNWIND $edges AS edge RETURN edge",
    "MATCH (a:WikiPage {id: node._from}), (b:WikiPage {id: node._to}) CREATE (a)-[:WikiRedirect]->(b)",
    {batchSize: 16384, parallel: true, params: {edges: $edges}}
)`;

export async function insertPages(batch:WikiPage[]) {
    return db.session().executeWrite(tx=>tx.run(insertPageApocIterateQuery, {batch}))
}

const insertRedirectQuery = 
`WITH $batch AS nodes
UNWIND nodes AS node
CREATE(:WikiPage{id:node.id,title:node.title,isRedirect:node.isRedirect})`;

const insertRedirectApocIterateQuery = 
`CALL apoc.periodic.iterate(
    "UNWIND $edges AS edge RETURN edge",
    "MATCH (a:WikiPage {id: node._from}), (b:WikiPage {id: node._to}) CREATE (a)-[:WikiRedirect]->(b)",
    {batchSize: 16384, parallel: true, params: {edges: $edges}}
)`;


export async function insertRedirects(batch:Edge[]) {
    return db.session().executeWrite(tx=>tx.run(insertRedirectApocIterateQuery, {batch}))
}

const insertLinkQuery = 
`WITH $batch AS nodes
UNWIND nodes AS node
MATCH (a:WikiPage {id: node._from}), (b:WikiPage {id: node._to}) CREATE (a)-[:WikiLink]->(b)`;

const insertLinkApocIterateQuery = 
`CALL apoc.periodic.iterate(
    "UNWIND $edges AS edge RETURN edge",
    "MATCH (a:WikiPage {id: edge._from}), (b:WikiPage {id: edge._to}) CREATE (a)-[:WikiLink]->(b)",
    {batchSize: 16384, parallel: true, params: {edges: $edges}}
)`;

export async function insertLinks(batch:Edge[]) {
    return db.session().executeWrite(tx=>tx.run(insertLinkApocIterateQuery, {batch}))
}
