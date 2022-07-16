import { exists } from "@utils";
import { mapSync, split } from "event-stream";
import got from "got/dist/source";
import type Request from "got/dist/source/core";
import { lang } from "../../index";
import { createReadStream, ReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

export class SqlDumpParser {
    inParenthesis = false;
    inString = false;
    escape = false;
    buffer = "";
    lastChunckPromise = Promise.resolve();
    path:string;
    url:string;
    stream!:ReadStream | Request;

    constructor(kind:string) {
        this.path = `cache/${lang}wiki-lastest-${kind}`;
        this.url = `https://dumps.wikimedia.org/${lang}wiki/latest/${lang}wiki-latest-${kind}`;
    }

    async process() {
        
        const inCache = await exists(this.path);
        console.log(this.path, this.url, inCache);
        this.stream =  inCache ? createReadStream(this.path) : got.stream(this.url);

        await new Promise<void>((resolve, reject)=>{
            this.stream
            .pipe(createGunzip())
            .pipe(split())          
            .pipe(
                mapSync(async (line: string) => {
                    for (const char of line) {
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
                    
                }).on('end', async ()=> {
                    await this.lastChunckPromise;
                    resolve()
                })
            );
        })
    }

    async processChunk(s:string) {

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
