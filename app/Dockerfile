FROM node:22-alpine
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev
COPY app/server.cjs app/background-store.cjs app/credential-store.cjs app/netease.cjs app/netease-auth.cjs app/netease-protocol.cjs app/netease.js app/style.css app/app.js app/personal-data.js app/music-library.js app/room.css app/room.js ./app/
COPY app/assets ./app/assets
COPY index.html ./
ENV HOST=0.0.0.0 PORT=8642 NODE_ENV=production
EXPOSE 8642
USER node
CMD ["node", "app/server.cjs"]
