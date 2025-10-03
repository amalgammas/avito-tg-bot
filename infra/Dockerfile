# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM base AS build
COPY package.json yarn.lock ./
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY apps ./apps
RUN yarn build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json yarn.lock ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/apps/bot-api/main.js"]
