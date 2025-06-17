import { promisify } from "node:util";
import { exec } from "node:child_process";
const execP = promisify(exec);

const WIKI_LANG     = process.env.WIKI_LANG;
const NEO4J_HOME    = process.env.NEO4J_HOME;

async function run(command:string) {
    return execP(command)
    .then(({ stdout, stderr }) => {
        console.log(stdout);
        console.error(stderr);
    }).catch(e => {
        console.log(e.stdout);
        console.error(e.stderr);
        throw e;
    });
}

async function closeComputeEngine() {
    await run(`gcloud --quiet compute instances delete \
        "$(curl -s -f -X GET http://metadata.google.internal/computeMetadata/v1/instance/name -H 'Metadata-Flavor: Google')" \
        --zone="$(curl -s -f -X GET http://metadata.google.internal/computeMetadata/v1/instance/zone -H 'Metadata-Flavor: Google')"`
    );
    process.exit(0);
}

await run(`gcloud config set project wikiadventure`);

await run(`neo4j start`).catch(async e => {
    console.error(`Failed to start`);
    await closeComputeEngine();
});

await import("./index.js").catch(async e => {
    console.error(`Dump parsing failed :(`);
    await closeComputeEngine();
});

await run(`neo4j stop`).catch(e => console.error(`Failed to stop neo4j gracefully :(`));

await run(`gsutil ls gs://${WIKI_LANG}-wiki-graph-data || gsutil mb -l eu gs://${WIKI_LANG}-wiki-graph-data`)
    .catch(e => console.error(`Failed to create Cloud Storage Bucket`));

await run(`gsutil requesterpays set on gs://${WIKI_LANG}-wiki-graph-data`)
    .catch(e => console.error(`Failed to add public requesterpays :(`));

await run(`gsutil iam ch allAuthenticatedUsers:objectViewer gs://${WIKI_LANG}-wiki-graph-data`)
    .catch(e => console.error(`Failed to change IAM policy :(`));

await run(`gsutil -m rm -r gs://${WIKI_LANG}-wiki-graph-data/*`)
    .catch(e => console.error(`Failed to clear the Cloud Storage Bucket :(`));

await run(`gsutil -m rm -r gs://${WIKI_LANG}-wiki-graph-data/*`)
    .catch(e => console.error(`Failed to clear the Cloud Storage Bucket :(`));

await run(`gsutil -m cp -r "${NEO4J_HOME}/data/*" gs://${WIKI_LANG}-wiki-graph-data `)
    .catch(e => console.error(`Failed to clear the Cloud Storage Bucket :(`));

await closeComputeEngine();
