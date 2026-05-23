FROM mcr.microsoft.com/playwright:v1.60.0-noble

ENV NODE_ENV=production \
    PORT=10000 \
    HOME=/home/pwuser \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 10000
CMD ["node", "server.js"]
