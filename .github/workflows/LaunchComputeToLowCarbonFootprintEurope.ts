import { exec } from "node:child_process";
import { promisify } from "node:util";
const execP = promisify(exec);

const WIKI_LANG                 = process.env.WIKI_LANG;
const DOCKER_USERNAME           = process.env.DOCKER_USERNAME;
const DOCKER_TOKEN              = process.env.DOCKER_TOKEN;
const GCP_SERVICE_ACCOUNT_EMAIL = process.env.GCP_SERVICE_ACCOUNT_EMAIL;

const lowCarbonFootprintRegionOrdered = [
    "europe-north2",
    "europe-west9",
    "europe-north1",
    "europe-west6",
    "europe-west1",
    "europe-southwest1",
    "europe-west2"
];

const machineType = "n1-standard-16";

for (const region of lowCarbonFootprintRegionOrdered) {
    const zoneLetters = region != "europe-west1" ? ["a","b","c"] : ["b","c","d"];
    for (const letter of zoneLetters) {
        const zone = `${region}-${letter}`;
        console.log(`Try to launch ${WIKI_LANG} graph compute in zone ${zone} with machine type ${machineType}`);
        const command = execP(`\
            gcloud compute instances create-with-container generate-${WIKI_LANG}wiki-rust-graph \
              --project=wikiadventure \
              --zone="${zone}" \
              --machine-type=${machineType} \
              --network-interface=network-tier=PREMIUM,stack-type=IPV4_ONLY,subnet=default \
              --maintenance-policy=MIGRATE \
              --provisioning-model=STANDARD \
              --service-account=${GCP_SERVICE_ACCOUNT_EMAIL} \
              --scopes=https://www.googleapis.com/auth/cloud-platform \
              --image=projects/cos-cloud/global/images/cos-stable-121-18867-90-59 \
              --boot-disk-size=250GB \
              --boot-disk-type=pd-ssd \
              --boot-disk-device-name=generate-wiki-graph \
              --container-image=europe-docker.pkg.dev/wikiadventure/wiki-graph/generate-wiki-rust-graph:latest \
              --container-restart-policy=never \
              --container-privileged \
              --container-mount-host-path=host-path=/var/run/docker.sock,mode=rw,mount-path=/var/run/docker.sock \
              --container-env=WIKI_LANG=${WIKI_LANG},DOCKER_USERNAME=${DOCKER_USERNAME},DOCKER_TOKEN=${DOCKER_TOKEN},USE_MULTITHREAD=true \
              --no-shielded-secure-boot \
              --shielded-vtpm \
              --shielded-integrity-monitoring \
              --labels=goog-ec-src=vm_add-gcloud \
              --reservation-affinity=any`
        );
        try {
            const { stdout, stderr } = await command;
            console.log(stdout);
            console.error(stderr);
            console.log(`Launch ${WIKI_LANG} graph compute in zone ${zone} with machine type ${machineType} with success`);
            process.exit(0);
        } catch(e:unknown) {
            const { stdout, stderr } = e as ({stdout: string,stderr: string}&Error);
            console.log(stdout);
            console.error(stderr);
            console.log(`Failed to launch ${WIKI_LANG} graph compute in zone ${zone} with machine type ${machineType}`);
        }
    }
}

process.exit(1);
