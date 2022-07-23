import { exists } from "@utils";
import { lang } from "../../index";
import { createGunzip } from 'node:zlib';
import { Agent, fetch, Response } from 'undici';
import { Readable, Writable } from "node:stream";


export class SqlDumpParser {
    inParenthesis = false;
    inString = false;
    escape = false;
    buffer = "";
    lastChunckPromise = Promise.resolve();
    path:string;
    url:string;
    stream!:Readable;

    constructor(kind:string) {
        this.path = `cache/${lang}wiki-lastest-${kind}`;
        this.url = `https://dumps.wikimedia.org/${lang}wiki/latest/${lang}wiki-latest-${kind}`;
    }

    async process() {
        const inCache = await exists(this.path);
        // inCache ? createReadStream(this.path) :
        
        

        await new Promise<void>(async (processComplete, _)=>{
            let bytesRead = 0;
            const unzip = createGunzip();
            const download = async () => {
                await new Promise<void>(async (resolve, reject)=>{
                    const data = await fetch(this.url,{
                        headers: {
                            "Accept-Encoding": "gzip",
                            "Range": `bytes=${bytesRead}-`
                        }
                    }).catch(e=>{
                        console.log(e);
                        download();
                    });
                    if (data?.body == null) {
                        return;
                    }
                    this.stream = Readable.fromWeb(data.body);
                    this.stream.on("error",e=>{
                        console.log("On Error : ", e);
                        download();
                    }).on("data", (data:Buffer)=>{
                        bytesRead+=data.byteLength;
                    });
                    this.stream
                    .pipe(unzip)
                    .pipe(
                        new Writable({
                            write: async (chunk, encoding, next) =>  {
                                await this.parseChunk(chunk);
                                next();
                            },
                        })
                        .on("finish",async ()=>{
                            await this.lastChunckPromise;
                            processComplete();
                            resolve();
                        })       
                    );
                })
            }
            download();
        })
    }

    async processChunk(s:string) {

    }

    async parseChunk(chunk:Buffer) {
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
                    await this.processChunk(this.buffer);
                    this.buffer = ""
                }
            }
        }
    }
}

export function parseQuote(s:string, index:number):[string, number] {
    var result = "";
    var resultEscape = false;
    var j = index+1;
    for (const char of s.slice(index)) {
        j++;
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

