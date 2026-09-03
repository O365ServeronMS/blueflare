# pg_dump must be at least the server's major version, so this tracks the same
# image tag and base OS as the postgres service. Bump both together.
FROM postgres:18.6-trixie

# curl signs S3 requests itself (--aws-sigv4), so no rclone or aws CLI is
# needed for any S3-compatible target. Trixie is Debian-based, so use apt.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 755 /usr/local/bin/backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
