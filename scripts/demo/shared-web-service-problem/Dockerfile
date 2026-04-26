FROM nginx:alpine

COPY default.conf /etc/nginx/conf.d/default.conf
COPY 40-cstrike-setup.sh /docker-entrypoint.d/40-cstrike-setup.sh

RUN chmod +x /docker-entrypoint.d/40-cstrike-setup.sh \
    && rm -f /usr/share/nginx/html/index.html
