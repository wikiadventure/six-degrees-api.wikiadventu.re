export function createDumpProgressLogger(bytesSizeOfDump: number, logTitle:string) {
    const title = logTitle;
    const dumpBytesSize = bytesSizeOfDump;
    let lastParsedAmount = 0;
    let lastBytesReadAmount = 0;
    const startTimestamp = Date.now();
    let lastTimestamp = startTimestamp;

    function log(bytesReadAmount: number, parsedAmount: number ) {
        const nowTimeStamp = Date.now();
        const moRead = bytesReadAmount/1024/1024;
        const moSince = (bytesReadAmount - lastBytesReadAmount) /1024/1024;
        const totalSpendTime = (nowTimeStamp - startTimestamp) / 1000;
        const spendTime = (nowTimeStamp -lastTimestamp) / 1000;
        const lastAmountParsed = parsedAmount - lastParsedAmount;
        const parsedPerSec = lastAmountParsed / spendTime;
        const moPerSec = moSince / spendTime;
        const moRemain = (dumpBytesSize - bytesReadAmount) /1024/1024;
        const estInSec = moRemain / moPerSec;
        const h = Math.floor(estInSec / 3600);
        const m = Math.floor((estInSec - (h * 3600)) / 60);
        const s = Math.floor(estInSec - (h * 3600) - (m * 60));
        const t = (n:number) => n.toString().padStart(2,"0");
        const estimation = `${t(h)}h${t(m)}m${t(s)}s`;

        const ram = process.memoryUsage().rss / 1024 / 1024;
        
        // if (ram > 20000) {
        //     console.log("Ram usage too high manually pausing stream...");
        //     this.stream.pause();
        // } else if (ram > 17000 && this.stream.isPaused()) {
        //     console.log("Stream resumed!");
        //     this.stream.resume();
        // }

        lastTimestamp = nowTimeStamp;
        lastParsedAmount = parsedAmount;
        lastBytesReadAmount = bytesReadAmount;

        console.log(`
        
${title} -> ${parsedAmount} parsed
Ram : ${( ram ).toFixed(2)} mo
${ totalSpendTime.toFixed(2) }s
${ parsedPerSec.toFixed(2) }parsed/s
${ moPerSec.toFixed(2) }mo/s
${ moRead.toFixed(2) + " / " + (dumpBytesSize/1024/1024).toFixed(2) } mo
${ estimation } estimation of time left
    
        `);
    }

    return {
        log
    }

}