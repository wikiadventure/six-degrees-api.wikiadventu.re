import { driver } from "neo4j-driver";
import type { Edge, WikiPage } from "../index.js";

export const db = driver("bolt://localhost:7687");

export async function initMemgraphIndex() {
    return Promise.all([
        db.session().run(`CREATE INDEX ON :WikiPage;`),
        db.session().run(`CREATE INDEX ON :WikiPage(id);`),
        db.session().run(`CREATE INDEX ON :WikiPage(title);`),
        db.session().run(`CREATE EDGE INDEX ON :WikiRedirect;`),
        db.session().run(`CREATE EDGE INDEX ON :WikiLink;`),
    ])
}

const insertPageQuery = 
`WITH $batch AS nodes
UNWIND nodes AS node
CREATE(:WikiPage{id:node.id,title:node.title})`;

export async function insertPages(batch:{id:string,title:string}[]) {
    return db.session().executeWrite(tx=>tx.run(insertPageQuery, {batch}))
}

const insertRedirectQuery = 
`WITH $batch AS nodes
UNWIND nodes AS node
MATCH (a:WikiPage {id: node.a}), (b:WikiPage {id: node.b}) CREATE (a)-[:WikiRedirect]->(b)`;

export async function insertRedirects(batch:{a:string,b:string}[]) {
    return db.session().executeWrite(tx=>tx.run(insertRedirectQuery, {batch}))
}

const insertLinkQuery = 
`WITH $batch AS nodes
UNWIND nodes AS node
MATCH (a:WikiPage {id: node.a}), (b:WikiPage {id: node.b}) CREATE (a)-[:WikiLink]->(b)`;

export async function insertLinks(batch:{a:string,b:string}[]) {
    return db.session().executeWrite(tx=>tx.run(insertLinkQuery, {batch}))
}
