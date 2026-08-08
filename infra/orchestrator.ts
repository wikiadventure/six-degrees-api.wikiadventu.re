import { $ } from "bun";
import { rm, mkdir, link } from "node:fs/promises";
import { join } from "node:path";
import type { DumpStatus } from "./types/dumpstatus";

const LANGUAGES = ["oc", "eo", "it", "de", "fr", "en"] as const; 
type Language = typeof LANGUAGES[number];

if (!process.env.DOCKER_USERNAME) {
  console.error("FATAL: DOCKER_USERNAME environment variable is required.");
  process.exit(1);
}
const DOCKER_IMAGE_PREFIX = `${process.env.DOCKER_USERNAME}/six-degrees-api`;
const METADATA_PATH = "../graphs/metadata.json";

type Metadata = Partial<Record<Language, string>>;

async function loadMetadata(): Promise<Metadata> {
  const file = Bun.file(METADATA_PATH);
  if (await file.exists()) {
    try {
      return await file.json();
    } catch {
      return {};
    }
  }
  return {};
}

async function saveMetadata(metadata: Metadata) {
  // Ensure directory exists
  await mkdir("../graphs", { recursive: true });
  await Bun.write(METADATA_PATH, JSON.stringify(metadata, null, 2));
}

// region: Verify dump date
/**
 * Step 0.25: Fetch and Verify Dump Dates
 */
async function getLatestReadyDumpDate(lang: Language): Promise<string | null> {
  console.log(`[${lang}] Fetching dump directory listing...`);
  const indexUrl = `https://dumps.wikimedia.org/${lang}wiki/`;
  const response = await fetch(indexUrl);
  if (!response.ok) {
    console.error(`[${lang}] Failed to fetch directory listing: ${response.statusText}`);
    return null;
  }
  const html = await response.text();

  // Extract dates, filter valid ones, and sort descending (newest first)
  const dates = Array.from(html.matchAll(/<a href="(\d{8})\/">/g))
    .map(match => match[1])
    .filter((date): date is string => date !== undefined)
    .sort((a, b) => b.localeCompare(a));

  const requiredJobs = ["pagetable", "redirecttable", "linktargettable", "pagelinkstable"];

  for (const date of dates) {
    console.log(`[${lang}] Checking dump status for date ${date}...`);
    const statusUrl = `https://dumps.wikimedia.org/${lang}wiki/${date}/dumpstatus.json`;
    const statusResponse = await fetch(statusUrl);
    if (!statusResponse.ok) continue;

    try {
      const statusData = await statusResponse.json() as DumpStatus;
      const jobs = statusData.jobs;
      if (!jobs) continue;

      // Verify All Files Ready
      const allJobsDone = requiredJobs.every(
        job => jobs[job] && jobs[job].status === "done" && jobs[job].files && Object.keys(jobs[job].files).length > 0
      );

      if (allJobsDone) {
        console.log(`[${lang}] Found ready dump: ${date}`);
        return date;
      } else {
        console.log(`[${lang}] Dump ${date} is incomplete. Checking older dates...`);
      }
    } catch (e) {
      console.warn(`[${lang}] Error parsing dumpstatus for ${date}:`, e);
    }
  }

  console.log(`[${lang}] No complete dump found.`);
  return null;
}

// region: Build graph-builder
/**
 * Step 0.5: Build the Data Processor upfront
 */
async function buildDataProcessor() {
  console.log("Building data processor (rust-graph-builder)...");
  const optFlags = process.env.OPTIMIZED_RUSTFLAGS || "-C target-cpu=znver2 -C target-feature=+aes,+avx2,+bmi1,+bmi2";
  await $`cd .. && RUSTFLAGS=${optFlags} cargo build --release --manifest-path=rust-graph-builder/Cargo.toml`;
}

// region: Login to docker
/**
 * Step 0.5: Login to Docker Hub
 */
async function loginToDocker() {
  const user = process.env.DOCKER_USERNAME;
  const pat = process.env.DOCKER_PAT;
  
  if (!user || !pat) {
    console.warn("DOCKER_USERNAME or DOCKER_PAT not set in environment. Skipping docker login...");
    return;
  }
  
  console.log(`[Docker] Logging into Docker Hub as ${user}...`);
  // Using shell piping to securely pass the password via stdin
  await $`echo ${pat} | docker login --username ${user} --password-stdin`;
}

// region: Generate graph
/**
 * Step 1: Run the Data Processor to generate graph.rkyv for a given language
 */
async function generateGraph(lang: Language, date: string) {
  console.log(`[${lang}] Running data processor (rust-graph-builder)...`);
  // Using WIKI_LANG or CLI args depending on your rust implementation.
  // We navigate to the parent repository root to execute the compiled binary.
  // const mirrorUrl = "https://ftp.acc.umu.se/mirror/wikimedia.org/dumps/";
  const mirrorUrl = "https://dumps.wikimedia.org/";
  await $`cd .. && WIKI_DUMP_MIRROR=${mirrorUrl} WIKI_LANG=${lang} WIKI_DATE=${date} ./rust-graph-builder/target/release/rust-graph-builder`;
}

// region: Docker build & push
/**
 * Step 2: Build the Serverless API Docker Images (Generic and Hardware-Optimized)
 */
async function buildAndPushDockerImages(lang: Language, date: string) {
  console.log(`[${lang}] Preparing Docker environment...`);
  
  // Link the giant graph memory so Docker can pick it up
  const targetPath = join("..", "graphs", lang, date, "graph.rkyv");
  const linkPath = join("..", "graph.rkyv");
  
  // Clean up any existing link first
  await rm(linkPath, { force: true });
  await link(targetPath, linkPath);

  try {
    const commitHash = (await $`git rev-parse --short HEAD`.text()).trim();
    const genericTag = `${DOCKER_IMAGE_PREFIX}-${lang}:${date}-${commitHash}`;
    const dateTag = `${DOCKER_IMAGE_PREFIX}-${lang}:${date}`;
    const latestTag = `${DOCKER_IMAGE_PREFIX}-${lang}:latest`;
    const localOptimizedTag = `${DOCKER_IMAGE_PREFIX}-${lang}:local-optimized`;
    
    // 1. Build & Push Generic Image (No specific CPU constraints)
    console.log(`[${lang}] Building GENERIC image for Docker Hub...`);
    await $`cd .. && docker build -f dockerfile.graph-api -t ${genericTag} -t ${dateTag} -t ${latestTag} --build-arg WIKI_LANG=${lang} --build-arg CUSTOM_RUSTFLAGS="" .`;
    console.log(`[${lang}] Pushing GENERIC image to registry...`);
    await $`docker push ${genericTag}`;
    await $`docker push ${dateTag}`;
    await $`docker push ${latestTag}`;
    console.log(`[${lang}] Removing GENERIC image locally to save disk space...`);
    await $`docker rmi ${genericTag} ${dateTag} ${latestTag}`;

    // 2. Build Hardware Optimized Image (Don't push, keep local)
    console.log(`[${lang}] Building OPTIMIZED image for Hetzner server...`);
    const optFlags = process.env.OPTIMIZED_RUSTFLAGS || "-C target-cpu=znver2";
    await $`cd .. && docker build -f dockerfile.graph-api -t ${localOptimizedTag} --build-arg WIKI_LANG=${lang} --build-arg CUSTOM_RUSTFLAGS=${optFlags} .`;
  } finally {
    // Cleanup the hard link regardless of build success
    await rm(linkPath, { force: true });
  }
}


// region: Gen Docker compose
/**
 * Generate a complete docker-compose.yml from the base and the target languages
 */
async function generateDockerCompose() {
  console.log("Generating docker-compose.yml from base...");
  const baseContent = await Bun.file("docker-compose.base.yml").text();
  
  let composeContent = baseContent;
  
  for (const lang of LANGUAGES) {
    const serviceName = `api-${lang}`;
    // We explicitly instruct Docker Compose to use the optimized local tag
    const imageTag = `${DOCKER_IMAGE_PREFIX}-${lang}:local-optimized`;
    // Traefik dynamically routes via host: lang.api.six-degrees.wikiadventu.re
    const traefikRule = `Host(\`${lang}.api.six-degrees.wikiadventu.re\`)`;
    
    composeContent += `
  ${serviceName}:
    image: "${imageTag}"
    container_name: "${serviceName}"
    environment:
      - WIKI_LANG=${lang}
      - REDIS_URL=redis://redis-cache:6379
    restart: unless-stopped
    networks:
      - web
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${serviceName}.rule=${traefikRule}"
      - "traefik.http.routers.${serviceName}.entrypoints=websecure"
      - "traefik.http.routers.${serviceName}.tls.certresolver=myresolver"
      - "traefik.http.routers.${serviceName}.tls.domains[0].main=api.six-degrees.wikiadventu.re"
      - "traefik.http.routers.${serviceName}.tls.domains[0].sans=*.api.six-degrees.wikiadventu.re"
      # Assuming your API runs on port 8080 internally, adjust if different
      - "traefik.http.services.${serviceName}.loadbalancer.server.port=8080"
`;
  }
  
  await Bun.write("docker-compose.yml", composeContent);
  console.log("docker-compose.yml generated successfully.");
}

// region: Deploy Traefik
/**
 * Step 4: Deploy and perform zero-downtime swap using Traefik & Docker Compose
 */
async function deployServices(lang: Language) {
  const serviceName = `api-${lang}`;
  console.log(`[Deploy] Updating container for ${serviceName} with local optimized image...`);
  // Note: We deliberately SKIP 'docker compose pull' so it doesn't overwrite our local-optimized image
  await $`docker compose up -d traefik redis-cache ${serviceName}`;
  
  console.log(`[Deploy] Purging redis cache for language ${lang}...`);
  await $`docker exec redis-cache sh -c "redis-cli --scan --pattern '${lang}:*' | xargs -r redis-cli del"`;
  
  // Clean up dangling images to save disk space on Hetzner
  await $`docker image prune -f`;
}

// region: Cleanup
/**
 * Step 5: Cleanup old cache and graphs files
 */
async function cleanupOldFiles(lang: Language, newDate: string, oldDate?: string) {
  if (!oldDate || oldDate === newDate) return;
  console.log(`[${lang}] Cleaning up old files for date: ${oldDate}`);
  try {
    await rm(`../cache/${lang}/${oldDate}`, { recursive: true, force: true });
    console.log(`[${lang}] Removed old cache directory: cache/${lang}/${oldDate}`);
  } catch (e) {
    console.warn(`[${lang}] Failed to remove old cache directory:`, e);
  }
  try {
    await rm(`../graphs/${lang}/${oldDate}`, { recursive: true, force: true });
    console.log(`[${lang}] Removed old graphs directory: graphs/${lang}/${oldDate}`);
  } catch (e) {
    console.warn(`[${lang}] Failed to remove old graphs directory:`, e);
  }
}

// region: Main
/**
 * Main Orchestrator Pipeline
 * Runs sequentially to avoid CPU/RAM bottlenecking on the host machine.
 */
async function runPipeline() {
  console.log("=== Starting Six Degrees of Wikipedia Pipeline ===");

  try {
    await loginToDocker();
    await buildDataProcessor();
  } catch (error) {
    console.error("[ERROR] Failed to build the data processor:", error);
    process.exit(1);
  }

  // Generate the composite docker-compose.yml based on current LANGUAGES
  try {
    await generateDockerCompose();
  } catch (error) {
    console.error("[ERROR] Failed to generate docker-compose.yml:", error);
    process.exit(1);
  }

  const metadata = await loadMetadata();

  for (const lang of LANGUAGES) {
    console.log(`\n--- Processing Language: ${lang.toUpperCase()} ---`);
    try {
      const latestDate = await getLatestReadyDumpDate(lang);
      if (!latestDate) {
        console.log(`[${lang}] No ready dump found. Skipping.`);
        continue;
      }

      const lastProcessed = metadata[lang];
      if (lastProcessed && latestDate <= lastProcessed) {
        console.log(`[${lang}] Dump date ${latestDate} is not newer than last processed (${lastProcessed}). Skipping.`);
        continue;
      }

      console.log(`[${lang}] New dump date found: ${latestDate}. Proceeding with build.`);

      await generateGraph(lang, latestDate);
      await buildAndPushDockerImages(lang, latestDate);
      await deployServices(lang);
      await cleanupOldFiles(lang, latestDate, lastProcessed);

      // Save the successful run date
      metadata[lang] = latestDate;
      await saveMetadata(metadata);

      console.log(`--- Finished Processing: ${lang.toUpperCase()} ---`);
    } catch (error) {
      console.error(`[ERROR] Pipeline failed for language ${lang}:`, error);
      // Exit explicitly so cron/systemd registers the failure
      process.exit(1);
    }
  }
}

// Execute
runPipeline();