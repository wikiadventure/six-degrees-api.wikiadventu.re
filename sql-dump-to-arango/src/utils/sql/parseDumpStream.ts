import { exists } from "@utils";
import { lang, max_group_per_request } from '../../index';
import { createGunzip } from 'node:zlib';
import { fetch } from 'undici';
import { Readable, Transform, Writable } from "node:stream";
import { createReadStream } from "node:fs";


export class SqlDumpParser<T> {
    params:T[] = [];
    inParenthesis = false;
    inString = false;
    escape = false;
    buffer = "";
    lastChunckPromise:Promise<any> = Promise.resolve();
    path:string;
    url:string;
    stream!:Readable;
    length!:number;
    startTime = Date.now();
    lastTime = this.startTime;
    bytesRead = 0;
    lastBytesRead = 0;
    parsed = 0;
    lastParsed = 0;
    type = "";

    // processStream!: Transform;

    constructor(kind:string) {
        this.path = `cache/${lang}wiki-latest-${kind}`;
        this.url = `https://dumps.wikimedia.org/${lang}wiki/latest/${lang}wiki-latest-${kind}`;
    }

    async process() {
        const inCache = await exists(this.path);
        // inCache ? createReadStream(this.path) :
        
        

        await new Promise<void>(async (processComplete, _)=>{
            this.bytesRead = 0;
            const temp = [];
            const unzip = createGunzip(
                {chunkSize: 1048576}
            );
            const download = async () => {
                await new Promise<void>(async (resolve, reject)=>{
                    const data = await fetch(this.url,{
                        headers: {
                            "Accept-Encoding": "gzip",
                            "Range": `bytes=${this.bytesRead}-`
                        }
                    }).catch(e=>{
                        console.log(e);
                        download();
                    });
                    if (data?.body == null) {
                        return;
                    }
                    if (this.length == null) this.length = parseInt(data.headers.get("Content-Length")||"0");
                    this.stream = Readable.fromWeb(data.body 
                        ,{highWaterMark: 8388608}
                    );
                    // this.stream = createReadStream(this.path);
                    this.stream.on("error",e=>{
                        console.log("On Error : ", e);
                        // download();
                    }).on("data", (data:Buffer)=>{
                        if (data.byteLength>0) this.bytesRead+=data.byteLength;
                    });
                    const self = this;
                    const processStream = this.stream
                    .pipe(unzip)
                    .pipe(
                        new Transform({
                            objectMode: true,
                            // highWaterMark: max_group_per_request,
                            transform(chunk, encoding, next) {
                                for (const p of self.parseChunk(chunk)) {
                                    if (p!=null) this.push(p);
                                }
                                next();
                            }
                        })
                    ).pipe(
                        new Transform({
                            objectMode: true,
                            // highWaterMark: max_group_per_request,
                            transform(chunk, encoding, next) {
                                const p = self.processChunk(chunk);
                                if (p!=null) {
                                    this.push(p);
                                    self.parsed++;
                                    if (self.parsed%(max_group_per_request*32)==0) self.log();
                                }
                                next();
                            }
                        })
                    )
                    this.processStreamPipe(processStream,processComplete,resolve);
                })
            }
            download();
        })
    }

    async onFinish() {

    }

    processStreamPipe(processStream:Transform, processComplete:(value: void | PromiseLike<void>) => void,resolve:(value: void | PromiseLike<void>) => void) {
        processStream
            .on("finish",async ()=>{
                // await this.processGroup(this.params);
                processComplete();
                resolve();
            })           
    }

    processChunk(s:string):T | null | undefined {
        return;
    }

    async processGroup(chunk:T[]) {

    }

    *parseChunk(chunk:Buffer) {
        for (const char of chunk.toString()) {
            const wasInParenthesis = this.inParenthesis;
            if (!this.escape) {
                if (char == "(") {
                    if (!this.inParenthesis) {
                        this.inParenthesis = true;
                    }
                } else if (this.inParenthesis && char =="'") {
                    this.inString = !this.inString;
                } else if (this.inParenthesis && !this.inString && char == ")") {
                    this.inParenthesis = false;
                } else if (this.inString && char == "\\") {
                    this.escape = true;
                }
            } else {
                this.escape = false;
            }
            if (wasInParenthesis) {
                if (this.inParenthesis) {
                    if (char != "\n" && char != "\r") {
                        this.buffer += char;
                    }
                } else {
                    yield this.buffer;
                    this.buffer = "";
                }
            }
        }
    }
    log() {
        const now = Date.now();
        const ram = process.memoryUsage().rss / 1024 / 1024;
        if (ram > 20000) {
            console.log("Ram usage too high manually pausing stream...");
            this.stream.pause();
        } else if (ram > 17000 && this.stream.isPaused()) {
            console.log("Stream resumed!");
            this.stream.resume();
        }
        const moRead = this.bytesRead/1024/1024;
        const moSince = (this.bytesRead - this.lastBytesRead) /1024/1024;
        const totalSpendTime = (now - this.startTime) / 1000;
        const spendTime = (now - this.lastTime) / 1000;
        const lastAmountParsed = this.parsed - this.lastParsed;
        const parsedPerSec = lastAmountParsed / spendTime;
        const moPerSec = moSince / spendTime;
        const moRemain = (this.length - this.bytesRead) /1024/1024;
        const estInSec = moRemain / moPerSec;
        const h = Math.floor(estInSec / 3600);
        const m = Math.floor((estInSec - (h * 3600)) / 60);
        const s = Math.floor(estInSec - (h * 3600) - (m * 60));
        const t = (n:number) => n.toString().padStart(2,"0");
        const estimation = `${t(h)}h${t(m)}m${t(s)}s`;
        console.log(`
        
${this.type} -> ${this.parsed} parsed
Ram : ${( ram ).toFixed(2)} mo
${ totalSpendTime.toFixed(2) }s
${ parsedPerSec.toFixed(2) }parsed/s
${ moPerSec.toFixed(2) }mo/s
${ moRead.toFixed(2) + " / " + (this.length/1024/1024).toFixed(2) } mo
${ estimation } estimation of time left

`);
        this.lastTime = now;
        this.lastParsed = this.parsed;
        this.lastBytesRead = this.bytesRead;
    }
}

export function parseQuote(s:string, index:number):[string, number] {
    var result = "";
    var resultEscape = false;
    var j = index;
    while (j<s.length) {
        j++;
        const char = s[j];
        if (!resultEscape) {
            if (char == "\\") {
                resultEscape = true;
                continue;
            } else if (char == "'") {
                break;
            } else {
                result += char;
            }
        } else {
            result += char;
            resultEscape = false;
        }
    }
    return [result, j];
}

