FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY config ./config

# Banco SQLite fica num volume para sobreviver a atualizações do container.
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "src/servidor.js"]
