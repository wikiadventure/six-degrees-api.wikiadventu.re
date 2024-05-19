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


const IS_GOOGLE_CLOUD_RUN = process.env["K_SERVICE"] !== undefined;

// You must listen on the port Cloud Run provides
const port = parseInt(process.env["PORT"] || "3000");

// You must listen on all IPV4 addresses in Cloud Run
const host = IS_GOOGLE_CLOUD_RUN ? "0.0.0.0" : "127.0.0.1";

// const { stderr, stdout} = await execP("arangod --daemon --pid-file /var/run/arangodb-node.pid ");
const DB_URL = "tcp://127.0.0.1:8529";


const db = new Database({
    url: DB_URL
});
const lang = process.env['WIKI_LANG'] ?? "eo";
const langDb = db.database(`${lang}wiki`);
const isUp = new Promise<void>(async (res,_) => {
    do { 
        try {
            await langDb.exists();
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
        const startPage = "page/"+start;
        const endPage = "page/"+end;
        await isUp;
        const query = await langDb.query(`
            FOR p IN OUTBOUND ALL_SHORTEST_PATHS '${startPage}' TO '${endPage}'
                link
                RETURN {
                    id: p.vertices[*]._key,
                    title: p.vertices[*].title
                }
        `);
        const result = await query.all();

        return c.json(result);
});


export default {
  fetch: app.fetch,
  port,
  hostname: host
} satisfies Serve;

type AllShortestPathParams = {
    start:number,
    end:number,
}