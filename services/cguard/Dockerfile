FROM node:20-alpine

# wget: healthcheck용, postgresql-client: postgresState.js의 psql CLI 호출용
RUN apk add --no-cache wget postgresql-client

WORKDIR /app

COPY package.json ./
COPY server/ ./server/
COPY shared/ ./shared/
COPY admin/ ./admin/
COPY db/ ./db/

EXPOSE 8500

CMD ["node", "server/start.js"]
