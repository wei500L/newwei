ARG REDIS_IMAGE=redis:7.2
FROM ${REDIS_IMAGE}

USER root
COPY infra/docker/scripts/redis-entrypoint.sh /usr/local/bin/redis-entrypoint.sh
RUN chmod 755 /usr/local/bin/redis-entrypoint.sh
USER redis
