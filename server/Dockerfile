FROM node:24-bookworm-slim
WORKDIR /app/server
COPY --chown=node:node *.mjs ./
RUN mkdir /data && chown node:node /data
USER node
ENV KATKA_HOST=0.0.0.0 KATKA_DATABASE=/data/katka.sqlite KATKA_PANEL_ORIGIN=https://pmikhail2009.github.io
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "main.mjs"]
