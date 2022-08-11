FROM node:18 as build
ENV NODE_ENV build

USER node
WORKDIR /home/node

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --foreground-scripts

COPY --chown=node:node . .
RUN npm run build \
    && npm prune --production

FROM node:alpine as main
ENV NODE_ENV production

USER node
WORKDIR /usr/src/app

COPY --from=build --chown=node:node /home/node/package*.json ./
COPY --from=build --chown=node:node /home/node/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /home/node/dist/ ./dist/

EXPOSE 8080
CMD ["node", "dist/index.js"]