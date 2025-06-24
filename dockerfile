# Use the official Alpine image as the base
FROM alpine:latest AS build

# Install necessary packages including Docker, Rust, and OpenSSL dependencies
RUN apk add --no-cache \
    docker \
    rust \
    openssl \
    openssl-dev \
    pkgconfig \
    cargo \
    git \
    bash

# Set up Docker in Docker
RUN mkdir -p /var/lib/docker

# Set environment variables for Rust
ENV PATH="/root/.cargo/bin:$PATH"

RUN cargo install cross

# Copy the source code for sql-dump-to-rust and rust-serverless
COPY ./sql-dump-to-rust /build/sql-dump-to-rust

RUN cd /build/sql-dump-to-rust && cargo build --release

COPY ./rust-serverless /build/rust-serverless

RUN cd /build/rust-serverless && cross build --release --target x86_64-unknown-linux-musl

FROM docker:dind

RUN apk add --no-cache \
        openssl \
        openssl-dev \
        libgcc

COPY --from=build /build/sql-dump-to-rust/target/release/sql-dump-to-rust /build/sql-dump-to-rust
COPY --from=build /build/rust-serverless/target/x86_64-unknown-linux-musl/release/rust-serverless /prod/rust-serverless
COPY dockerfile.serverless /prod/dockerfile
COPY entrypointGCP.sh entrypointGCP.sh

# Install gcloud CLI
RUN apk add --no-cache curl python3 py3-pip
RUN curl -O https://dl.google.com/dl/cloudsdk/release/google-cloud-sdk.tar.gz \
    && tar -xzf google-cloud-sdk.tar.gz \
    && mv google-cloud-sdk /usr/local/ \
    && /usr/local/google-cloud-sdk/install.sh \
    && rm google-cloud-sdk.tar.gz

# Add gcloud to PATH
ENV PATH="/usr/local/google-cloud-sdk/bin:$PATH"

CMD ["sh", "entrypointGCP.sh"]