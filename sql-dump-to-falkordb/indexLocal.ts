import { spawn } from "node:child_process";

spawn("sh", ["/var/lib/falkordb/bin/run.sh"], {
    detached: true,
    stdio: 'ignore'
}).unref();;


await import("./index.js");