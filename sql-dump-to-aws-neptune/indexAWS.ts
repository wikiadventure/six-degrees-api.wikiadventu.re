import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { NeptuneClient, StartLoaderJobCommand, GetLoaderJobStatusCommand } from "@aws-sdk/client-neptune";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execP = promisify(exec);

const REGION = process.env.AWS_REGION!;
const S3_BUCKET = process.env.S3_BUCKET!;
const S3_PREFIX = process.env.S3_PREFIX || "wiki-bulk/";
const NEPTUNE_ENDPOINT = process.env.NEPTUNE_ENDPOINT!;
const NEPTUNE_IAM_ROLE_ARN = process.env.NEPTUNE_IAM_ROLE_ARN!;

const s3 = new S3Client({ region: REGION });
const neptune = new NeptuneClient({ region: REGION, endpoint: `https://${NEPTUNE_ENDPOINT}` });

async function uploadCsvFiles(localDir: string, s3Bucket: string, s3Prefix: string) {
    const files = fs.readdirSync(localDir).filter(f => f.endsWith(".csv"));
    for (const file of files) {
        const filePath = path.join(localDir, file);
        const fileStream = fs.createReadStream(filePath);
        const key = path.posix.join(s3Prefix, file);
        console.log(`Uploading ${file} to s3://${s3Bucket}/${key}`);
        await s3.send(new PutObjectCommand({
            Bucket: s3Bucket,
            Key: key,
            Body: fileStream,
        }));
    }
    return files.length;
}

async function startBulkLoad(s3Bucket: string, s3Prefix: string) {
    const source = `s3://${s3Bucket}/${s3Prefix}`;
    const params = {
        Source: source,
        Format: "csv",
        RoleArn: NEPTUNE_IAM_ROLE_ARN,
        Region: REGION,
        FailOnError: true,
        Parallelism: "HIGH",
        UpdateSingleCardinalityProperties: true,
    };
    const command = new StartLoaderJobCommand(params);
    const response = await neptune.send(command);
    return response;
}

async function waitForBulkLoad(jobId: string) {
    while (true) {
        const statusCmd = new GetLoaderJobStatusCommand({ LoaderId: jobId });
        const statusResp = await neptune.send(statusCmd);
        const status = statusResp.Status;
        console.log(`Bulk load job status: ${status}`);
        if (status === "LOAD_COMPLETED" || status === "LOAD_FAILED" || status === "LOAD_CANCELLED") {
            return statusResp;
        }
        await new Promise(res => setTimeout(res, 30000)); // Wait 30s
    }
}

async function shutdownEC2Instance() {
    try {
        // Extract curl commands for clarity
        const instanceIdCurl = 'curl -s http://169.254.169.254/latest/meta-data/instance-id';
        const regionCurl = 'curl -s http://169.254.169.254/latest/meta-data/placement/region';
        const terminateCmd = `aws ec2 terminate-instances --instance-ids $( ${instanceIdCurl} ) --region $( ${regionCurl} )`;
        console.log('Terminating EC2 instance with command:', terminateCmd);
        await execP(terminateCmd);
        console.log('Terminate command sent.');
    } catch (e) {
        console.error('Failed to terminate EC2 instance:', e);
    }
    process.exit(0);
}

// 1. Upload all CSVs
const localDir = "./neptune-csv";
const uploaded = await uploadCsvFiles(localDir, S3_BUCKET, S3_PREFIX);
console.log(`Uploaded ${uploaded} CSV files to S3.`);

// 2. Start Neptune bulk loader
const loadResp = await startBulkLoad(S3_BUCKET, S3_PREFIX).catch(e=>({}));
const jobId = loadResp?.LoaderId;
if (!jobId) {
    console.error("Failed to start Neptune bulk load job.");
} else {
    console.log(`Started Neptune bulk load job: ${jobId}`);
}


// 3. Shutdown EC2 instance after starting the bulk load job
await shutdownEC2Instance();