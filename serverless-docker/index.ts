import { exec } from "node:child_process";
// const execP = promisify(exec);
// await execP("neo4j start");
const neo4jProcess = exec("neo4j console --verbose");
neo4jProcess.stdout?.pipe(process.stdout);
neo4jProcess.stderr?.pipe(process.stderr);
import { Hono } from "hono";
import { serve } from '@hono/node-server';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { zValidator } from '@hono/zod-validator';
import { z } from "zod";
import { driver } from "neo4j-driver";


const app = new Hono();

app.use('/*', cors());
app.use(compress())
app.notFound((c) => c.json({ message: 'Not Found', ok: false }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ message: 'Internal Server Error', ok: false }, 500);
});

// You must listen on the port Cloud Run provides
const port = parseInt(process.env["PORT"] || "3000");

const DB_URL = "bolt://127.0.0.1:7687";

const db = driver(
    DB_URL,
    undefined,
    { disableLosslessIntegers: true }
);

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

app.get(
    "/all-shortest-path/:start/to/:end",
    zValidator(
        'param',
        z.object({
            start: z.coerce.number().int().min(1),
            end: z.coerce.number().int().min(1),
        })
    ),
    async (c, next)=>{
        const { start, end } = c.req.param();
        await isUp;
        console.log(`query ${start} to ${end}`);
        const startTime = performance.now();
        const query = 
`CYPHER runtime = parallel
MATCH (from:WikiPage {id: ${start}}), (to:WikiPage {id: ${end}})
MATCH rawPaths = allShortestPaths((from)-[:WikiLink*]->(to))
WITH collect(DISTINCT nodes(rawPaths)) AS allPathNodes
UNWIND allPathNodes AS pathNodes
UNWIND pathNodes AS node
WITH DISTINCT node, pathNodes
WITH collect([toInteger(node.id), node.title]) AS idToTitlePairs, collect([p IN pathNodes | toInteger(p.id)]) as paths
RETURN apoc.map.fromPairs(idToTitlePairs) AS idToTitle, paths`
        const result = await db.session({ database: 'neo4j' }).executeRead(tx=>tx.run(query));
        const out = result.records[0].toObject();
        out.time = performance.now() - startTime;
        return c.json(out);
});


console.log(`Server running on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
})
