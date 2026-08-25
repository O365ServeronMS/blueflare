# pg_dump must be at least the server's major version, so this tracks the same
# image tag the postgres service runs. Bump both together.
FROM postgres:18.6-alpine

# curl signs S3 requests itself (--aws-sigv4), so no rclone or aws CLI is
# needed for any S3-compatible target.
RUN apk add --no-cache bash curl

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 755 /usr/local/bin/backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
