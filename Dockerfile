FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app

# Ferramentas para compilar better-sqlite3, caso não haja binário pronto
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

# Banco e criativos ficam em /app/data (monte um volume aqui)
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
