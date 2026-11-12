# opencode v2 sidecar: `opencode serve` on the compose network, used by the
# worker's AI module (backend/src/ai/, provider kind `opencode`). The binary is
# the pinned npm platform package, checked against its registry sha512.
FROM debian:bookworm-slim

ARG OPENCODE_VERSION=2.2.7
ARG OPENCODE_SHA512=c24fc33c7c6be266a25be166429f33b685e5a3fbc2e6ab261081ec2cd68d2d92f689a2187e1caa1517ba091b02571cbe89bd2c7cad3b5f621ea45c3b6522aa35

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/oc.tgz "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-${OPENCODE_VERSION}.tgz" \
 && echo "${OPENCODE_SHA512}  /tmp/oc.tgz" | sha512sum -c - \
 && tar -xzf /tmp/oc.tgz -C /tmp package/bin/opencode \
 && install -m 0755 /tmp/package/bin/opencode /usr/local/bin/opencode \
 && rm -rf /tmp/oc.tgz /tmp/package \
 && useradd --uid 1000 --create-home --home-dir /data opencode

COPY entrypoint.sh /usr/local/bin/opencode-entrypoint
USER 1000:1000
ENV HOME=/data \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_CLAUDE_CODE=1 \
    OPENCODE_DISABLE_FILEWATCHER=1
WORKDIR /data
EXPOSE 4096
ENTRYPOINT ["/usr/local/bin/opencode-entrypoint"]
