cd /build/ &&
# Run the build rust binary to create graph.rkyv
/build/sql-dump-to-rust &&
mv graph.rkyv /prod/ &&
cd /prod &&
echo $DOCKER_TOKEN | docker login -u $DOCKER_USERNAME --password-stdin &&
docker build -f dockerfile -t sacramentix1225/${WIKI_LANG}wiki-rust-graph .
docker push sacramentix1225/${WIKI_LANG}wiki-rust-graph &&
echo finished

