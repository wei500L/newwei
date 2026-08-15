ARG LITELLM_IMAGE=ghcr.io/berriai/litellm@sha256:067aee932b8770ed42955ee802a04abdcd369d0995b5e696bb07d6520a231b1c
FROM ${LITELLM_IMAGE}

COPY infra/litellm/litellm-config.yaml /app/config.base.yaml
COPY infra/litellm/generate-litellm-config.py /app/generate-litellm-config.py

# Startup writes /app/config.yaml from the base template; keep that directory
# writable by the non-root runtime user.
RUN if ! id -u app >/dev/null 2>&1; then \
      groupadd --system app && \
      useradd --system --gid app --uid 10001 --home-dir /app --no-create-home app; \
    fi \
 && chown -R app:app /app

USER app
