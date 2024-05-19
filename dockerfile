###################################### Base image ######################################

FROM docker:dind

######################################     ENV    ######################################

ENV ARANGO_VERSION 3.9.2
ENV ARANGO_NO_AUTH 1
ENV NODE_OPTIONS=--max_old_space_size=16384
ENV NODE_VERSION 18.6.0

###################################### Arango db  ######################################
FROM alpine:3.17
MAINTAINER Frank Celler <info@arangodb.com>

ENV ARANGO_VERSION 3.12.0.2

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

# retain the database directory and the Foxx Application directory
VOLUME ["/var/lib/arangodb3", "/var/lib/arangodb3-apps"]

COPY docker-entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

#  
######################################  Node js   ######################################

RUN addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node \
    && apk add --no-cache \
        libstdc++ \
    && apk add --no-cache --virtual .build-deps \
        curl \
    && ARCH= && alpineArch="$(apk --print-arch)" \
      && case "${alpineArch##*-}" in \
        x86_64) \
          ARCH='x64' \
          CHECKSUM="b9deb73770a8b2c5d4c6926bad723f68366718bb196b6278137fc6f6489147fe" \
          ;; \
        *) ;; \
      esac \
  && if [ -n "${CHECKSUM}" ]; then \
    set -eu; \
    curl -fsSLO --compressed "https://unofficial-builds.nodejs.org/download/release/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH-musl.tar.xz"; \
    echo "$CHECKSUM  node-v$NODE_VERSION-linux-$ARCH-musl.tar.xz" | sha256sum -c - \
      && tar -xJf "node-v$NODE_VERSION-linux-$ARCH-musl.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
      && ln -s /usr/local/bin/node /usr/local/bin/nodejs; \
  else \
    echo "Building from source" \
    # backup build
    && apk add --no-cache --virtual .build-deps-full \
        binutils-gold \
        g++ \
        gcc \
        gnupg \
        libgcc \
        linux-headers \
        make \
        python3 \
    # gpg keys listed at https://github.com/nodejs/node#release-keys
    && for key in \
      4ED778F539E3634C779C87C6D7062848A1AB005C \
      141F07595B7B3FFE74309A937405533BE57C7D57 \
      94AE36675C464D64BAFA68DD7434390BDBE9B9C5 \
      74F12602B6F1C4E913FAA37AD3A89613643B6201 \
      71DCFD284A79C3B38668286BC97EC7A07EDE3FC1 \
      61FC681DFB92A079F1685E77973F295594EC4689 \
      8FCCA13FEF1D0C2E91008E09770F7A9A5AE15600 \
      C4F0DFFF4E8C1A8236409D08E73BC641CC11F4C8 \
      890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4 \
      C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C \
      DD8F2338BAE7501E3DD5AC78C273792F7D83545D \
      A48C2BEE680E841632CD4E44F07496B3EB3C1762 \
      108F52B48DB57BB0CC439B2997B01419BD92F80A \
      B9E2F5981AA6E0CD28160D9FF13993A75599653C \
    ; do \
      gpg --batch --keyserver hkps://keys.openpgp.org --recv-keys "$key" || \
      gpg --batch --keyserver keyserver.ubuntu.com --recv-keys "$key" ; \
    done \
    && curl -fsSLO --compressed "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION.tar.xz" \
    && curl -fsSLO --compressed "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt.asc" \
    && gpg --batch --decrypt --output SHASUMS256.txt SHASUMS256.txt.asc \
    && grep " node-v$NODE_VERSION.tar.xz\$" SHASUMS256.txt | sha256sum -c - \
    && tar -xf "node-v$NODE_VERSION.tar.xz" \
    && cd "node-v$NODE_VERSION" \
    && ./configure \
    && make -j$(getconf _NPROCESSORS_ONLN) V= \
    && make install \
    && apk del .build-deps-full \
    && cd .. \
    && rm -Rf "node-v$NODE_VERSION" \
    && rm "node-v$NODE_VERSION.tar.xz" SHASUMS256.txt.asc SHASUMS256.txt; \
  fi \
  && rm -f "node-v$NODE_VERSION-linux-$ARCH-musl.tar.xz" \
  && apk del .build-deps \
  # smoke tests
  && node --version \
  && npm --version

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

# WORKDIR /project/sql-dump-to-arango

EXPOSE 8529

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
  npm run build &&\
  npm start &&\
  # Generate a dump of the 'final' Arango database
  (arangodump --server.authentication false --output-directory "/project/serverless-docker/dump" --server.database "${WIKI_LANG}wiki" || true) &&\
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
  cd /project/serverless-docker &&\
  # Build the image for the current lang
  docker build -f dockerfile . --build-arg wiki_lang=${WIKI_LANG} -t sacramentix1225/${WIKI_LANG}wiki-graph &&\
  # Push it to docker hub
  docker push sacramentix1225/${WIKI_LANG}wiki-graph &&\
  # Configure to push to GCR hub too
  gcloud auth configure-docker &&\
  # Configure to push to GCR hub too
  docker tag sacramentix1225/${WIKI_LANG}wiki-graph eu.gcr.io/sixdegreesofwikiadventure/${WIKI_LANG}wiki-graph &&\
  # Push to GCR.io
  docker push eu.gcr.io/sixdegreesofwikiadventure/${WIKI_LANG}wiki-graph &&\
  # Create a new Google Cloud Run
  gcloud run deploy ${WIKI_LANG}wiki-graph-serverless --image=eu.gcr.io/sixdegreesofwikiadventure/${WIKI_LANG}wiki-graph:latest \
  --cpu=2 --max-instances=15 --memory=2Gi --port=8080 --allow-unauthenticated \
  --region=europe-west9 --project=sixdegreesofwikiadventure &&\
  # Delete the Instance running this script
  gcloud compute instances delete --zone europe-west9-a $HOSTNAME
