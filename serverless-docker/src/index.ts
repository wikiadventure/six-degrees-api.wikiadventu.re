import { aql, Database } from 'arangojs';
import Fastify, { FastifyInstance } from "fastify";
import { setTimeout, setInterval } from "node:timers/promises";
import { promisify } from "node:util";
import { exec } from "node:child_process";
const execP = promisify(exec);

function build() {
    return Fastify({ trustProxy: true })
}
  
async function start() {
    // Google Cloud Run will set this environment variable for you, so
    // you can also use it to detect if you are running in Cloud Run
    const IS_GOOGLE_CLOUD_RUN = process.env["K_SERVICE"] !== undefined;

    // You must listen on the port Cloud Run provides
    const port = parseInt(process.env["PORT"] || "3000");

    const WAIT_DAEMON = parseInt(process.env["WAIT_DAEMON"] || "5000");

    // You must listen on all IPV4 addresses in Cloud Run
    const host = IS_GOOGLE_CLOUD_RUN ? "0.0.0.0" : "127.0.0.1";

    try {
        try {

            const { stderr, stdout} = await execP("arangod --daemon --pid-file /var/run/arangodb-node.pid ");

        } catch (e) {

        }
        const server = build();
        await routes(server);
        await setTimeout(WAIT_DAEMON);

        await server.listen({ port, host });
    } catch (err) {
        console.error(err);
    }
}

module.exports = build

if (require.main === module) {
    start()
}

async function routes(server:FastifyInstance) {

    const DB_URL = "tcp://127.0.0.1:8529";

    const db = new Database({
        url: DB_URL
    });
    const lang = process.env['WIKI_LANG'] ?? "eo";
    const langDb = db.database(`${lang}wiki`);
    var up = false;
    do { 
        try {
            up = await langDb.exists();
        } catch(e) {
        }
        await setTimeout(50);
    } while (!up);

    server.get("/all-shortest-path/:start/to/:end", async (req, res)=>{

        const params = req.params as AllShortestPathParams;
        const start = "page/"+params.start;
        const end = "page/"+params.end;
        const n = await (await langDb.query(aql`
            RETURN length(
                FOR p IN OUTBOUND SHORTEST_PATH ${start} TO ${end} GRAPH wikiGraph
                    return {}
            ) - 1 
        `)).next();
        if (n<1) {

        }
        if (n==2) {

        }
        const result = await (await langDb.query(aql`
            FOR p IN ${n}..${n} OUTBOUND K_PATHS ${start} TO ${end} GRAPH wikiGraph
            return { title: p.vertices[*].title, id: p.vertices[*]._key }
        `)).all();

        res.send(result);

    })
}

type AllShortestPathParams = {
    start:number,
    end:number,
}