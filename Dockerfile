# alive-buddy 主服务（Fastify API + WebSocket）
FROM node:20-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY data/training_data.csv ./data/training_data.csv
# data/characters（SQLite 记忆与角色状态）须挂卷持久化，否则容器重建即失忆
EXPOSE 3000
CMD ["node", "dist/api/index.js"]
