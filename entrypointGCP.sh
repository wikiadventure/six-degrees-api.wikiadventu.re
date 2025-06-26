cd /build/ &&
# Run the build rust binary to create graph.rkyv
/build/sql-dump-to-rust &&
mv graph.rkyv /prod/ &&
cd /prod &&
docker login -u $DOCKER_USERNAME -p $DOCKER_TOKEN &&
docker build -f dockerfile -t sacramentix1225/${WIKI_LANG}wiki-rust-graph . &&
docker push sacramentix1225/${WIKI_LANG}wiki-rust-graph &&
gcloud auth configure-docker europe-west9-docker.pkg.dev --quiet &&
docker tag sacramentix1225/${WIKI_LANG}wiki-rust-graph europe-west9-docker.pkg.dev/wikiadventure/wiki-graph/${WIKI_LANG}wiki-rust-graph &&\
(for i in {1..5}; do docker push europe-west9-docker.pkg.dev/wikiadventure/wiki-graph/${WIKI_LANG}wiki-rust-graph && exit 0; sleep 15; done; exit 1) &&
# Create a new Google Cloud Run
gcloud run deploy ${WIKI_LANG}wiki-rust-graph-serverless --image=europe-west9-docker.pkg.dev/wikiadventure/wiki-graph/${WIKI_LANG}wiki-rust-graph:latest \
--cpu=8 --max-instances=4 --memory=32Gi --port=8080 --allow-unauthenticated \
--execution-environment=gen2 \
--region=europe-west9 --project=wikiadventure &&
# Delete the Instance running this script
export INSTANCE_NAME=$(curl -X GET http://metadata.google.internal/computeMetadata/v1/instance/name -H 'Metadata-Flavor: Google') &&
export INSTANCE_ZONE=$(curl -X GET http://metadata.google.internal/computeMetadata/v1/instance/zone -H 'Metadata-Flavor: Google') &&
gcloud --quiet compute instances delete $INSTANCE_NAME --zone=$INSTANCE_ZONE &&
echo finished

