import { createWriteStream, existsSync } from "fs";
import { createGunzip, type Gunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { env } from "../env.js";
import { mkdir } from "fs/promises";

export type FileType = "page" | "redirect" | "pagelinks" | "linktarget";
export async function sqlDumpStreamFromCache(fileType:FileType) {
    const path = `./cache/${env.WIKI_LANG}/${env.WIKI_LANG}wiki-latest-${fileType}.sql.gz`;
    if (!existsSync(path)) {
        await mkdir(`./cache/${env.WIKI_LANG}`, {recursive: true}).catch();
        const writeToFile = createWriteStream(path);
        const response = await fetch(`https://dumps.wikimedia.org/${env.WIKI_LANG}wiki/latest/${env.WIKI_LANG}wiki-latest-${fileType}.sql.gz`);
        const size = parseInt(response.headers.get("Content-Length") || "0");
        let bytesDownloaded = 0;
        let lastLoggedProgress = 0;
        const startTime = Date.now();

        for await (const chunk of response.body) {
            bytesDownloaded += chunk.byteLength;
            writeToFile.write(chunk);

            // Log progress every 1MB
            if (bytesDownloaded - lastLoggedProgress >= 1024 * 1024) {
                const elapsedTime = Date.now() - startTime;
                const averageSpeed = bytesDownloaded / elapsedTime;
                const remainingBytes = size - bytesDownloaded;
                const estimatedRemainingTime = remainingBytes / averageSpeed;
                const progressPercentage = (bytesDownloaded / size) * 100;
                const estInSec = estimatedRemainingTime / 1000;
                const h = Math.floor(estInSec / 3600);
                const m = Math.floor((estInSec - (h * 3600)) / 60);
                const s = Math.floor(estInSec - (h * 3600) - (m * 60));
                const t = (n:number) => n.toString().padStart(2,"0");
                const estimation = `${t(h)}h${t(m)}m${t(s)}s`;
                const mbDownloaded = (bytesDownloaded / 1024 /1024).toFixed(2);
                const mbSize = (size / 1024 /1024).toFixed(2);
                console.log(`Downloaded: ${mbDownloaded}mb/${mbSize}mb (${progressPercentage.toFixed(2)}%)`);
                console.log(`Estimated remaining time: ${estimation}`);

                lastLoggedProgress = bytesDownloaded;
            }
        }

        writeToFile.end();
    }
    const gunzip = createGunzip(
        {chunkSize: 64*1024}
    );
    const { size } = await stat(path);
    const info = {
        size,
        bytesRead: 0
    }
    const stream = createReadStream(`./cache/${env.WIKI_LANG}/${env.WIKI_LANG}wiki-latest-${fileType}.sql.gz`)
                    .on("data", (chunk:Buffer)=> info.bytesRead+=chunk.byteLength)
                    .pipe(gunzip)
    stream.setEncoding("utf-8");
    return {
        info,
        stream
    }
}

export async function sqlDumpStreamFromWeb(fileType:FileType) {
    const gunzip = createGunzip(
        {chunkSize: 1024*1024*32 }
    );
    gunzip.setEncoding("utf-8");
    gunzip
    const info = {
        size: 0,
        bytesRead: 0
    }
    const { promise: forFetchHeaders, resolve } = Promise.withResolvers<void>();
    async function attachFetchDownloadStream() {
        fetch(`https://dumps.wikimedia.org/${env.WIKI_LANG}wiki/latest/${env.WIKI_LANG}wiki-latest-${fileType}.sql.gz`,{
            headers: {
                "Accept-Encoding": "gzip",
                "Range": `bytes=${info.bytesRead}-`
            },
        }).then(async r => {
            if (info.size == 0) {
                info.size = parseInt(r.headers.get("Content-Length")||"0");
                resolve();
            }
            
            for await (const chunk of r.body) {
                info.bytesRead+=chunk.byteLength;
                const capNotReached = gunzip.write(chunk);
                if (!capNotReached) {
                    const { promise: forDrain, resolve } = Promise.withResolvers<void>();
                    gunzip.once('drain',resolve);
                    await forDrain;
                }
                
            }
            gunzip.end();
        }).catch(e=>{
            attachFetchDownloadStream();
        })
    }
    attachFetchDownloadStream();
    await forFetchHeaders;
    return {
        info,
        stream: gunzip
    }
}

export async function sqlDumpStream(fileType:FileType) {
    if (env.USE_CACHE == 1) return sqlDumpStreamFromCache(fileType);
    return sqlDumpStreamFromWeb(fileType);
}

type ToTupleString<T extends any[]> = { [K in keyof T]: string };

export async function* parseDumpContent<Ks extends string[]>(stream: Gunzip, keyToYield: Ks): AsyncGenerator<ToTupleString<Ks>, void, unknown> {
    /*  
        A variable to store what remains of what we read to parse the 
        header of the sql dump to retreive fields with their order
        because if we don't we might over read and skip the begin of the dump content
        where the values are.
    */
    let remains = "";
    // Fields is an array that will contains all fields of the table being dumped in the order
    // they will appear in th eocntent part
    const fields:string[] = [];
    // We used a label to break inside nested loop
    processCreateTable: for await (const content of stream.iterator({destroyOnReturn: false}) as  AsyncIterableIterator<string>) {
        // We transform the content into iterable of lines
        const lines = content.split('\n').values();
        for (const line of lines) {
            if (line.startsWith("CREATE TABLE")) break;
        }
        for (const line of lines) {
            const [,field] = /^\s*`(.*)`/.exec(line) ?? [];
            if (field != null) fields.push(field);
            else if (line.startsWith(")")) {
                for (const lineRemains of lines) {
                    remains+=lineRemains;
                }
                break processCreateTable;
            }
        }
    }

    const keyToIndex = fields.reduce<Record<string,number>>((obj, field, index) => {
        obj[field] = index;
        return obj;
    }, {});

    const indexToYield = keyToYield.map(k=>keyToIndex[k]);

    let inside_parenthesis = false;
    let inside_string = false;
    let escaped = false;
    let current_value = "";
    let values:string[] = [];

    function processChar(c:string) {
        if (inside_parenthesis) {
            if (inside_string) {
                if (escaped) {
                    current_value += c;
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (c == '\'') {
                    inside_string = false;
                } else {
                    current_value += c;
                }
            } else {
                if (c == '\'') {
                    inside_string = true;
                } else if (c == ',') {
                    values.push(current_value);
                    current_value = "";
                } else if (c == ')') {
                    inside_parenthesis = false;
                    values.push(current_value);
                    current_value = "";
                    return true;
                } else {
                    current_value += c;
                }
            }
        } else if (c == '(') {
            inside_parenthesis = true;
        }
        return false;
    }
    // We first process what's remain of Create table parsing process
    for (const c of remains){
        const blockIsFinished = processChar(c);
        if (blockIsFinished) {
            yield indexToYield.map(index => values[index]) as any;
            values = [];
        }
    }
    // We can now parse the whole stream :)
    for await (const content of stream ) {
    for (const c of content as string) {
        const blockIsFinished = processChar(c);
        if (blockIsFinished) {
            yield indexToYield.map(index => values[index]) as any;
            values = [];
        }
    }}
}
