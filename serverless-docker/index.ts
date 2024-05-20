import { aql, Database } from 'arangojs';
import { Hono } from "hono";
import { cors } from 'hono/cors';
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { type Serve } from "bun";
import { zValidator } from '@hono/zod-validator';
import { z } from "zod";

const execP = promisify(exec);

const app = new Hono();

app.use('/*', cors());
app.notFound((c) => c.json({ message: 'Not Found', ok: false }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ message: 'Internal Server Error', ok: false }, 500);
});

// You must listen on the port Cloud Run provides
const port = parseInt(process.env["PORT"] || "3000");

const { stderr, stdout } = await execP("arangod --daemon --pid-file /var/run/arangodb-node.pid");
const DB_URL = "tcp://127.0.0.1:8529";


const db = new Database({
    url: DB_URL
});
const lang = process.env['WIKI_LANG'] ?? "eo";
const langDb = db.database(`${lang}wiki`);
const isUp = new Promise<void>(async (res,_) => {
    console.log(`Waiting arango...`);
    const startTime = Date.now();
    do {    
        try {
            await langDb.exists();
            console.log(`Arango up (${Date.now() - startTime}ms)`);
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
        console.log(`query from ${start} to ${end}`);
        const startPage = "page/"+start;
        const endPage = "page/"+end;
        await isUp;
        const startTime = performance.now();
        const query = await langDb.query(`
            FOR p IN OUTBOUND ALL_SHORTEST_PATHS '${startPage}' TO '${endPage}'
                link
                RETURN {
                    id: p.vertices[*]._key,
                    title: p.vertices[*].title
                }
        `);
        const result = await query.all() as {id: string[], title: string[]}[];
        const time = performance.now() - startTime;
        const out = {
            idToTitle: result.reduce<Record<number,string>>((acc, { id, title })=>{
                    id.forEach((v,i)=>acc[Number(v)]=title[i]);
                    return acc;
                }, {}),
            paths: result.map(({id})=>id.map(v=>Number(v))),
            time
        }

        return c.json(out);
});


console.log(`Server running on port ${port}...`);

export default {
  fetch: app.fetch,
  port,
};
