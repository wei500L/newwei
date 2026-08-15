ARG PYTHON_IMAGE=python:3.11-slim
FROM ${PYTHON_IMAGE}

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  VIRTUAL_ENV=/opt/venv \
  PATH="/opt/venv/bin:$PATH"

ARG AKSHARE_VERSION=1.18.39
ARG PIP_INDEX_URL=
ARG PIP_TRUSTED_HOST=

RUN python -m venv "$VIRTUAL_ENV" && \
  python -m pip install --no-cache-dir --upgrade pip && \
  python -c "import sys; assert sys.version_info >= (3, 9), 'akshare gateway requires Python >= 3.9 (base image too old)'" && \
  if [ -n "$PIP_INDEX_URL" ]; then python -m pip config set global.index-url "$PIP_INDEX_URL"; fi && \
  if [ -n "$PIP_TRUSTED_HOST" ]; then python -m pip config set global.trusted-host "$PIP_TRUSTED_HOST"; fi

COPY infra/akshare/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt

RUN if [ "$AKSHARE_VERSION" = "latest" ]; then \
    python -m pip install --no-cache-dir --upgrade akshare; \
  else \
    python -m pip install --no-cache-dir "akshare==${AKSHARE_VERSION}"; \
  fi

COPY infra/akshare/main.py ./main.py

RUN groupadd --system app \
  && useradd --system --gid app --uid 10001 --home-dir /app --no-create-home app \
  && chown -R app:app /app /opt/venv

USER app

EXPOSE 8081

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8081"]
