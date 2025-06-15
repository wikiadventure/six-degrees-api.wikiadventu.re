cd /project/sql-dump-to-neo4j &&
# Start Neo4j in background
/var/lib/neo4j/bin/neo4j start  &&
# Build and run the dump parser with Node js
npm start &&
# Push the content of $NEO4J_HOME/data to Google Cloud Storage
# Create the Google Cloud Storage bucket if it doesn't exist
gsutil ls gs://${WIKI_LANG}wiki-graph-data || gsutil mb -l eu gs://${WIKI_LANG}wiki-graph-data &&
gsutil requesterpays set on gs://${WIKI_LANG}wiki-graph-data &&
gsutil iam ch allAuthenticatedUsers:objectViewer gs://${WIKI_LANG}wiki-graph-data &&
# # Clear the storage bucket before uploading new data
gsutil -m rm -r gs://${WIKI_LANG}wiki-graph-data/** || true &&
gsutil -m cp -r /data/* gs://${WIKI_LANG}wiki-graph-data && 
echo finished