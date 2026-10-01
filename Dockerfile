FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY engine.js server.js ./
COPY public ./public
ENV DATA_FILE=/data/table.json
EXPOSE 3000
CMD ["node", "server.js"]
