import { Database } from "arangojs";
import { env } from "../env.js";
import type { DocumentCollection, EdgeCollection } from "arangojs/collection.js";
import type { Edge, WikiPage } from "../index.js";

export const db = new Database();

export var langDb:Database;

export async function initLangDatabase() {
    try {
        await db.createDatabase(`${env.LANG}wiki`);
    } catch(e) {}
    langDb = db.database(`${env.LANG}wiki`);
    return langDb;
}

export async function insertPages(batch:WikiPage[], pageCollection:DocumentCollection<WikiPage>) {
    return pageCollection.import(batch, {
        onDuplicate: "ignore",
    });
}

export async function insertRedirects(batch:Edge[], redirectCollection:EdgeCollection<{}>) {
    return redirectCollection.import(batch, {
        fromPrefix: "page/",
        toPrefix: "page/",
        onDuplicate: "ignore",
    });
}

export async function insertLinks(batch:Edge[], linkCollection:EdgeCollection<{}>) {
    return linkCollection.import(batch, {
        fromPrefix: "page/",
        toPrefix: "page/",
        onDuplicate: "ignore",
    });
}
