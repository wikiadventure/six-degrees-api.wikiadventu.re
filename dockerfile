FROM node:22.2.0-alpine3.19 AS node

###################################### Base image ######################################

FROM docker:26.1.3-dind-alpine3.19

######################################     ENV    ######################################

ENV ARANGO_VERSION 3.12.0.2
ENV ARANGO_NO_AUTH 1
ENV NODE_OPTIONS=--max_old_space_size=16384
ENV NODE_VERSION 22.1.0

######################################    Node    ######################################

COPY --from=node /usr/lib /usr/lib
COPY --from=node /usr/local/lib /usr/local/lib
COPY --from=node /usr/local/include /usr/local/include
COPY --from=node /usr/local/bin /usr/local/bin

###################################### Arango db  ######################################

# see
#   https://docs.arangodb.com/3.12/components/arangodb-server/options/#--serverendpoint
#   https://docs.arangodb.com/3.12/components/arangodb-server/options/#log

RUN apk add --no-cache gnupg pwgen binutils numactl numactl-tools && \
    gpg --batch --keyserver keys.openpgp.org --recv-keys 8003EDF6F05459984878D4A6C04AD0FD86FEC04D && \
    mkdir /docker-entrypoint-initdb.d && \
    cd /tmp                                && \
    arch="$(apk --print-arch)"             && \
    case "$arch" in                           \
        x86_64)  dpkgArch='amd64'          ;; \
        aarch64) dpkgArch='arm64'          ;; \
        *) echo >&2 "unsupported: $arch" && exit 1 ;; \
    esac                                   && \
    ARANGO_URL="https://download.arangodb.com/arangodb312/DEBIAN/$dpkgArch" && \
    ARANGO_PACKAGE="arangodb3_${ARANGO_VERSION}-1_${dpkgArch}.deb" && \
    ARANGO_PACKAGE_URL="${ARANGO_URL}/${ARANGO_PACKAGE}" && \
    ARANGO_SIGNATURE_URL="${ARANGO_PACKAGE_URL}.asc" && \
    wget ${ARANGO_SIGNATURE_URL}           && \
    wget ${ARANGO_PACKAGE_URL}             && \
    gpg --verify ${ARANGO_PACKAGE}.asc     && \
    ar x ${ARANGO_PACKAGE} data.tar.gz     && \
    tar -C / -x -z -f data.tar.gz          && \
    sed -ri \
        -e 's!127\.0\.0\.1!0.0.0.0!g' \
        -e 's!^(file\s*=\s*).*!\1 -!' \
        -e 's!^\s*uid\s*=.*!!' \
        /etc/arangodb3/arangod.conf        && \
    chgrp -R 0 /var/lib/arangodb3 /var/lib/arangodb3-apps && \
    chmod -R 775 /var/lib/arangodb3 /var/lib/arangodb3-apps && \
    rm -f ${ARANGO_PACKAGE}* data.tar.gz && \
    apk del gnupg
# Note that Openshift runs containers by default with a random UID and GID 0.
# We need that the database and apps directory are writable for this config.

ENV GLIBCXX_FORCE_NEW=1

# Adjust TZ by default since tzdata package isn't present (BTS-913)
RUN echo "UTC" > /etc/timezone

##################################### Google Cloud #####################################

ARG CLOUD_SDK_VERSION=476.0.0
ENV CLOUD_SDK_VERSION=$CLOUD_SDK_VERSION
ENV PATH /google-cloud-sdk/bin:$PATH
RUN if [ `uname -m` = 'x86_64' ]; then echo -n "x86_64" > /tmp/arch; else echo -n "arm" > /tmp/arch; fi;
RUN ARCH=`cat /tmp/arch` && apk --no-cache add \
        curl \
        python3 \
        py3-crcmod \
        py3-openssl \
        bash \
        libc6-compat \
        openssh-client \
        git \
        gnupg \
    && curl -O https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-sdk-${CLOUD_SDK_VERSION}-linux-${ARCH}.tar.gz && \
    tar xzf google-cloud-sdk-${CLOUD_SDK_VERSION}-linux-${ARCH}.tar.gz && \
    rm google-cloud-sdk-${CLOUD_SDK_VERSION}-linux-${ARCH}.tar.gz && \
    gcloud config set core/disable_usage_reporting true && \
    gcloud config set component_manager/disable_update_check true && \
    gcloud config set metrics/environment github_docker_image && \
    gcloud --version
RUN git config --system credential.'https://source.developers.google.com'.helper gcloud.sh

# #######################################  Docker  #######################################

# RUN apk add docker

#######################################  Script  #######################################

WORKDIR /project

COPY . .

WORKDIR /project/sql-dump-to-arango

RUN npm i

WORKDIR /project/


CMD \
  cd /project/sql-dump-to-arango &&\
  # Copy the GCP credential to GCP.json file from the ENV
  echo $GCP_JSON > GCP.json &&\
  # Connect to Google Cloud
  gcloud auth activate-service-account --key-file=GCP.json &&\
  # Start Arango db in background
  arangod --daemon --pid-file /var/run/arangodb.pid &&\
  # Build and run the dump parser with Node js
  npm i &&\
  npm start &&\
  # Generate a dump of the 'final' Arango database
  # (arangodump --server.authentication false --output-directory "/project/serverless-docker/dump" --server.database "${WIKI_LANG}wiki" || true) &&\
  # # Drop the  Google cloud storage
  # (gsutil rm -r -f "gs://graph-${WIKI_LANG}wiki" || true) &&\
  # # Recreate it 
  # (gsutil mb -p sixdegreesofwikiadventure -l EUROPE-WEST9 "gs://graph-${WIKI_LANG}wiki" || true) &&\
  # # Transfer the dump folder to the storage
  # gsutil cp -r "/project/serverless-docker/dump" "gs://graph-${WIKI_LANG}wiki" &&\
  # echo "Arango dump successfully exported to Google cloud storage" &&\
  # Start docker
  # (/usr/local/bin/dockerd-entrypoint.sh & sleep 20) &&\
  # Login to docker hub
  docker login -u $DOCKER_USERNAME -p $DOCKER_PASSWORD &&\
  # cd to start building a image for cloud run
  cd / &&\
  # Build the image for the current lang
  docker build -f /project/serverless-docker/dockerfile / --build-arg wiki_lang=${WIKI_LANG} -t sacramentix1225/${WIKI_LANG}wiki-graph &&\
  # Push it to docker hub
  docker push sacramentix1225/${WIKI_LANG}wiki-graph &&\
  # Configure to push to GCR hub too
  gcloud auth configure-docker europe-west9-docker.pkg.dev --quiet &&\
  # Configure to push to GCR hub too
  docker tag sacramentix1225/${WIKI_LANG}wiki-graph europe-west9-docker.pkg.dev/sixdegreesofwikiadventure/wiki-graph/${WIKI_LANG}wiki-graph &&\
  # Push to GCR.io
  docker push europe-west9-docker.pkg.dev/sixdegreesofwikiadventure/wiki-graph/${WIKI_LANG}wiki-graph &&\
  # Create a new Google Cloud Run
  gcloud run deploy ${WIKI_LANG}wiki-graph-serverless --image=europe-west9-docker.pkg.dev/sixdegreesofwikiadventure/wiki-graph/${WIKI_LANG}wiki-graph:latest \
  --cpu=2 --max-instances=15 --memory=2Gi --port=8080 --allow-unauthenticated \
  --region=europe-west9 --project=sixdegreesofwikiadventure &&\
  # Delete the Instance running this script
  export INSTANCE_NAME=$(curl -X GET http://metadata.google.internal/computeMetadata/v1/instance/name -H 'Metadata-Flavor: Google') &&\
  export INSTANCE_ZONE=$(curl -X GET http://metadata.google.internal/computeMetadata/v1/instance/zone -H 'Metadata-Flavor: Google') &&\
  gcloud --quiet compute instances delete $INSTANCE_NAME --zone=$INSTANCE_ZONE
