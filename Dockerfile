FROM denoland/deno:alpine-2.5.0

WORKDIR /app

COPY deno.json deno.lock ./
COPY server/ ./server/
COPY web/ ./web/

# Vendor the JSR deps into the image so startup needs no network.
RUN deno install --entrypoint --frozen server/main.ts

ENV TAPO_ROOT=/data \
    PORT=8000 \
    HOST=0.0.0.0

USER deno
EXPOSE 8000

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/cameras" >/dev/null || exit 1

# The footage mount is read-only to the process as well as to Docker.
CMD ["deno", "run", "--allow-read=/data,/app/web", "--allow-env", "--allow-net", "server/main.ts"]
