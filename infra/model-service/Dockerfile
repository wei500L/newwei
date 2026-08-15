ARG PYTHON_IMAGE=python:3.11-slim
FROM ${PYTHON_IMAGE}

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  VIRTUAL_ENV=/opt/venv \
  PATH="/opt/venv/bin:$PATH"

ARG PIP_INDEX_URL=
ARG PIP_TRUSTED_HOST=

RUN python -m venv "$VIRTUAL_ENV" && \
  python -m pip install --no-cache-dir --upgrade pip && \
  python -c "import sys; assert sys.version_info >= (3, 11), 'model service requires Python >= 3.11 (base image too old)'" && \
  if [ -n "$PIP_INDEX_URL" ]; then python -m pip config set global.index-url "$PIP_INDEX_URL"; fi && \
  if [ -n "$PIP_TRUSTED_HOST" ]; then python -m pip config set global.trusted-host "$PIP_TRUSTED_HOST"; fi

COPY infra/model-service/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY infra/model-service/main.py ./main.py

RUN groupadd --system app \
  && useradd --system --gid app --uid 10001 --home-dir /app --no-create-home app \
  && chown -R app:app /app /opt/venv

USER app

EXPOSE 8090

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090"]

