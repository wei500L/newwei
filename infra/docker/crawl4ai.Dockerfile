ARG CRAWL4AI_IMAGE=unclecode/crawl4ai:0
FROM ${CRAWL4AI_IMAGE}

COPY infra/docker/crawl4ai/ssrf_proxy.py /opt/modular/crawl4ai-ssrf-proxy.py
