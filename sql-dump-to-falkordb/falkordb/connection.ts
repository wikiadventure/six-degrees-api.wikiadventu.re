import { createClient } from "redis";
import { setTimeout } from "node:timers/promises";
import type { Edge, WikiPage } from "../index.js";
import { env } from "../env.js";

export const db = createClient({
    url: "redis://localhost:6379"
});

db.on('error', err => console.log('Redis Client Error', err));

await db.connect();

const WIKI_LANG = env.WIKI_LANG;

const graphName = `${WIKI_LANG}wiki`;

const isUp = new Promise<void>(async (res,_) => {
    console.log(`Waiting FalkorDB...`);
    const startTime = Date.now();
    do {
        try {
            await db.ping();
            console.log(`FalkorDB up (${Date.now() - startTime}ms)`);
            res();
            return;
        } catch(e) {
        }
        await setTimeout(50);
    } while (true);
});

await isUp;

export async function initFalkorDbIndex() {
    return Promise.all([
        db.graph.query(graphName, `CREATE INDEX FOR (n:WikiPage) ON (n.id)`),
        db.graph.query(graphName, `CREATE INDEX FOR (n:WikiPage) ON (n.title)`),
    ])
}

const insertPageQuery =
`UNWIND $batch AS node CREATE(:WikiPage{id:node.id,title:node.title,isRedirect:node.isRedirect})`;

export async function insertPages(batch:WikiPage[]) {
    return db.graph.query(graphName, insertPageQuery, { params: { batch }})
}

const insertRedirectQuery =
`UNWIND $batch AS node MATCH (a:WikiPage {id: node._from}), (b:WikiPage {id: node._to}) CREATE (a)-[:WikiRedirect]->(b)`;

export async function insertRedirects(batch:Edge[]) {
    return db.graph.query(graphName, insertRedirectQuery, { params: { batch }})
}

const insertLinkQuery =
`UNWIND $batch AS node MATCH (a:WikiPage {id: node._from}), (b:WikiPage {id: node._to}) CREATE (a)-[:WikiLink]->(b)`;

export async function insertLinks(batch:Edge[]) {
    return db.graph.query(graphName, insertLinkQuery, { params: { batch }})
}

const pageLabel = "WikiPage";
const idProperty = "id";
const titleProperty = "title";
const isRedirectProperty = "isRedirect";
const redirectRelation = "WikiRedirect";
const linkRelation = "WikiLink";

const entityStrings = [pageLabel, idProperty, titleProperty, isRedirectProperty, redirectRelation, linkRelation];
const stringMapping = new Map<string, number>();
entityStrings.forEach((s, i) => stringMapping.set(s, i));

function buildStringMappingPayload(): Buffer {
    const stringBuffers: Buffer[] = [];
    stringBuffers.push(Buffer.from([0x02])); // STRING_MAPPING token
    const stringCount = Buffer.alloc(4);
    stringCount.writeUInt32LE(entityStrings.length, 0);
    stringBuffers.push(stringCount);

    for (const str of entityStrings) {
        const strBuffer = Buffer.from(str, 'utf8');
        const len = Buffer.alloc(4);
        len.writeUInt32LE(strBuffer.length, 0);
        stringBuffers.push(len);
        stringBuffers.push(strBuffer);
    }
    return Buffer.concat(stringBuffers);
}

function buildNodeBulkPayload(batch: WikiPage[]): Buffer {
    const nodeBuffers: Buffer[] = [];
    const pageLabelId = stringMapping.get(pageLabel)!;
    const idPropertyId = stringMapping.get(idProperty)!;
    const titlePropertyId = stringMapping.get(titleProperty)!;
    const isRedirectPropertyId = stringMapping.get(isRedirectProperty)!;

    for (const node of batch) {
        nodeBuffers.push(Buffer.from([0x01])); // NODE_CREATION token

        const labelCount = Buffer.alloc(2);
        labelCount.writeUInt16LE(1, 0);
        nodeBuffers.push(labelCount);

        const labelId = Buffer.alloc(4);
        labelId.writeUInt32LE(pageLabelId, 0);
        nodeBuffers.push(labelId);

        const propCount = Buffer.alloc(2);
        propCount.writeUInt16LE(3, 0);
        nodeBuffers.push(propCount);

        // id property
        const idKey = Buffer.alloc(4);
        idKey.writeUInt32LE(idPropertyId, 0);
        nodeBuffers.push(idKey);
        nodeBuffers.push(Buffer.from([0x03])); // type integer
        const idVal = Buffer.alloc(8);
        idVal.writeBigInt64LE(BigInt(node.id), 0);
        nodeBuffers.push(idVal);

        // title property
        const titleKey = Buffer.alloc(4);
        titleKey.writeUInt32LE(titlePropertyId, 0);
        nodeBuffers.push(titleKey);
        nodeBuffers.push(Buffer.from([0x05])); // type string
        const titleVal = Buffer.from(node.title, 'utf8');
        const titleLen = Buffer.alloc(4);
        titleLen.writeUInt32LE(titleVal.length, 0);
        nodeBuffers.push(titleLen);
        nodeBuffers.push(titleVal);

        // isRedirect property
        const isRedirectKey = Buffer.alloc(4);
        isRedirectKey.writeUInt32LE(isRedirectPropertyId, 0);
        nodeBuffers.push(isRedirectKey);
        nodeBuffers.push(Buffer.from([0x01])); // type boolean
        nodeBuffers.push(Buffer.from([node.isRedirect ? 1 : 0]));
    }

    return Buffer.concat(nodeBuffers);
}


export async function insertPagesBulk(batch:WikiPage[]) {
    if (batch.length === 0) {
        return;
    }

    const stringMappingPayload = buildStringMappingPayload();
    const nodePayload = buildNodeBulkPayload(batch);
    const payload = Buffer.concat([stringMappingPayload, nodePayload]);

    return db.sendCommand([
        'GRAPH.BULK',
        graphName,
        'BEGIN',
        batch.length.toString(),
        '0',
        payload
    ]);
}

function buildEdgeBulkPayload(batch: Edge[], relationTypeId: number, idMap: Map<number, bigint>): [Buffer, number] {
    const edgeBuffers: Buffer[] = [];
    let edgeCount = 0;

    for (const edge of batch) {
        const srcInternalId = idMap.get(edge._from);
        const destInternalId = idMap.get(edge._to);

        if (srcInternalId !== undefined && destInternalId !== undefined) {
            edgeBuffers.push(Buffer.from([0x03])); // EDGE_CREATION token

            const relationId = Buffer.alloc(4);
            relationId.writeUInt32LE(relationTypeId, 0);
            edgeBuffers.push(relationId);

            const srcId = Buffer.alloc(8);
            srcId.writeBigUInt64LE(srcInternalId, 0);
            edgeBuffers.push(srcId);

            const destId = Buffer.alloc(8);
            destId.writeBigUInt64LE(destInternalId, 0);
            edgeBuffers.push(destId);

            const propCount = Buffer.alloc(2);
            propCount.writeUInt16LE(0, 0);
            edgeBuffers.push(propCount);
            edgeCount++;
        }
    }

    return [Buffer.concat(edgeBuffers), edgeCount];
}

async function insertEdgesBulk(batch: Edge[], relationName: string) {
    if (batch.length === 0) {
        return;
    }

    const ids = new Set<number>();
    for (const edge of batch) {
        ids.add(edge._from);
        ids.add(edge._to);
    }

    const idArray = Array.from(ids);
    const query = `UNWIND $ids as pageId MATCH (n:WikiPage {id: pageId}) RETURN n.id, ID(n)`;
    const result = await db.graph.query(graphName, query, { params: { ids: idArray } });

    const idMap = new Map<number, bigint>();
    if (result.data) {
        for (const record of result.data) {
            const id = record[0] as number;
            const internalId = record[1] as bigint;
            idMap.set(id, internalId);
        }
    }

    const stringMappingPayload = buildStringMappingPayload();
    const relationTypeId = stringMapping.get(relationName)!;
    const [edgePayload, edgeCount] = buildEdgeBulkPayload(batch, relationTypeId, idMap);

    if (edgeCount === 0) {
        return;
    }

    const payload = Buffer.concat([stringMappingPayload, edgePayload]);

    return db.sendCommand([
        'GRAPH.BULK',
        graphName,
        'BEGIN',
        '0',
        edgeCount.toString(),
        payload
    ]);
}

export async function insertRedirectsBulk(batch:Edge[]) {
    return insertEdgesBulk(batch, redirectRelation);
}

export async function insertLinksBulk(batch:Edge[]) {
    return insertEdgesBulk(batch, linkRelation);
}

