FROM kasmweb/chromium:1.18.0

USER root

# Render exposes one public HTTP port. Kasm's standalone browser image normally
# serves KasmVNC on 6901, so we override NO_VNC_PORT to Render's default port.
# We also disable KasmVNC's inner TLS because Render terminates HTTPS at its edge
# and forwards plain HTTP to the container.
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
