FROM kasmweb/chromium:1.18.0

USER root

# KasmVNC expects Debian's default ssl-cert files during startup. The base image
# log shows they are missing on Render, so generate the standard local-only
# placeholders inside the image. Render still terminates public HTTPS outside.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ssl-cert \
    && make-ssl-cert generate-default-snakeoil --force-overwrite \
    && chmod 640 /etc/ssl/private/ssl-cert-snakeoil.key \
    && chmod 644 /etc/ssl/certs/ssl-cert-snakeoil.pem \
    && chown root:ssl-cert /etc/ssl/private/ssl-cert-snakeoil.key \
    && usermod -aG ssl-cert kasm-user \
    && rm -rf /var/lib/apt/lists/*

ENV NO_VNC_PORT=10000 \
    VNC_PORT=5901 \
    VNC_RESOLUTION=1280x720 \
    MAX_FRAME_RATE=24 \
    LAUNCH_URL=https://lite.duckduckgo.com/lite/ \
    APP_ARGS="--no-first-run --no-default-browser-check --disable-sync --disable-extensions --disable-notifications --disable-background-networking --disable-features=TranslateUI,MediaRouter,AutofillServerCommunication --mute-audio" \
    VNCOPTIONS="-PreferBandwidth -DynamicQualityMin=3 -DynamicQualityMax=6 -DLP_ClipDelay=0"

COPY kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml

EXPOSE 10000

USER 1000
