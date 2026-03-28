ARG LITELLM_IMAGE=ghcr.io/berriai/litellm@sha256:067aee932b8770ed42955ee802a04abdcd369d0995b5e696bb07d6520a231b1c
FROM ${LITELLM_IMAGE}

COPY infra/litellm/litellm-config.yaml /app/config.base.yaml
COPY infra/litellm/generate-litellm-config.py /app/generate-litellm-config.py
