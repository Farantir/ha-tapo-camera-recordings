FROM python:3.12-slim

# ffmpeg does the decoding; everything else is pure Python + ONNX Runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py fetch_models.sh ./
RUN chmod +x fetch_models.sh

ENV TAPO_ROOT=/data \
    TAGS_FILE=/tags/tags.json \
    MODELS_DIR=/models \
    PYTHONUNBUFFERED=1

# Docker seeds a fresh named volume from the image's directory, permissions
# included. Creating these world-writable first is what lets the container run
# as an arbitrary PUID/PGID — otherwise the volume arrives owned by root and
# neither the models nor the sidecar can be written.
RUN mkdir -p /tags /models && chmod 0777 /tags /models

# The footage is read-only; only /tags and /models are ever written to.
VOLUME ["/tags", "/models"]

# Models are fetched on first start into the /models volume, so the image stays
# small and swapping detector size does not mean rebuilding it.
ENTRYPOINT ["/bin/sh", "-c", "./fetch_models.sh && exec python tag_events.py"]
