FROM kasmweb/chromium:1.18.0

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends ssl-cert nginx \
    && make-ssl-cert generate-default-snakeoil --force-overwrite \
    && chmod 640 /etc/ssl/private/ssl-cert-snakeoil.key \
    && chmod 644 /etc/ssl/certs/ssl-cert-snakeoil.pem \
    && chown root:ssl-cert /etc/ssl/private/ssl-cert-snakeoil.key \
    && usermod -aG ssl-cert kasm-user \
    && mkdir -p /home/kasm-user/.vnc /usr/share/nginx/html \
    && chown -R kasm-user:root /home/kasm-user/.vnc \
    && rm -rf /var/lib/apt/lists/*

ENV PORT=10000 \
    NO_VNC_PORT=6901 \
    VNC_PORT=5901 \
    VNC_RESOLUTION=960x540 \
    MAX_FRAME_RATE=18 \
    LAUNCH_URL=https://lite.duckduckgo.com/lite/ \
    APP_ARGS="--no-first-run --no-default-browser-check --disable-sync --disable-extensions --disable-notifications --disable-background-networking --disable-features=TranslateUI,MediaRouter,AutofillServerCommunication,OptimizationHints,InterestFeedContentSuggestions --mute-audio" \
    VNCOPTIONS="-PreferBandwidth -FrameRate=18 -DynamicQualityMin=3 -DynamicQualityMax=5 -JpegVideoQuality=4 -WebpVideoQuality=4 -ZlibLevel=1"

COPY nginx-render.conf /etc/nginx/conf.d/default.conf
COPY portal.html /usr/share/nginx/html/index.html
COPY kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml
COPY --chown=kasm-user:root kasmvnc.yaml /home/kasm-user/.vnc/kasmvnc.yaml
COPY render-start.sh /render-start.sh
RUN chmod +x /render-start.sh

EXPOSE 10000

ENTRYPOINT ["/bin/bash", "/render-start.sh"]
CMD []
