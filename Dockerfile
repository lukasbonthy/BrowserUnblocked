FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=10000 \
    DISPLAY=:99 \
    RESOLUTION=1440x900x24 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080 \
    CHROME_HOME=https://www.google.com \
    HOME=/home/browser

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-l10n \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    novnc \
    openbox \
    python3 \
    tini \
    websockify \
    x11vnc \
    xdotool \
    xterm \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x /app/bin/start.sh \
  && useradd -m -d /home/browser -s /bin/bash browser \
  && mkdir -p /home/browser/Downloads /home/browser/.config/chromium /tmp/chromium-profile \
  && chown -R browser:browser /home/browser /tmp/chromium-profile /app

USER browser

EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/bin/start.sh"]
