ARG CRAWL4AI_IMAGE=unclecode/crawl4ai:0.9.2@sha256:bd36741e7bdd35ddc1a05d9183e1d6d8cefb61dd640d944a25d026b76e917690
FROM ${CRAWL4AI_IMAGE}

COPY infra/docker/crawl4ai/ssrf_proxy.py /opt/modular/crawl4ai-ssrf-proxy.py

# Patch /health version at build time so the runtime process does not need write
# access to /app/server.py.
RUN python - <<'PY'
import pathlib
import re

version = "unknown"
try:
    import crawl4ai.__version__ as version_module

    version = (
        getattr(version_module, "__version__", None)
        or getattr(version_module, "VERSION", None)
        or "unknown"
    )
except Exception:
    version = "unknown"

if isinstance(version, str) and version.strip() and version != "unknown":
    server_path = pathlib.Path("/app/server.py")
    if server_path.is_file():
        content = server_path.read_text(encoding="utf-8")
        updated, count = re.subn(
            r'^__version__\s*=\s*["\'][^"\']*["\']',
            f'__version__ = "{version.strip()}"',
            content,
            count=1,
            flags=re.MULTILINE,
        )
        if count > 0:
            server_path.write_text(updated, encoding="utf-8")
            print(f"[crawl4ai] /health version patched to {version.strip()}")
PY

# Chromium/Xvfb need a writable /tmp (compose mounts tmpfs). Drop root so a
# browser RCE is not container root.
RUN if ! id -u crawler >/dev/null 2>&1; then \
      groupadd --system crawler && \
      useradd --system --gid crawler --uid 10001 --create-home crawler; \
    fi \
 && mkdir -p /tmp /opt/modular \
 && chown -R crawler:crawler /opt/modular /tmp \
 && (chown -R crawler:crawler /app || true)

USER crawler
