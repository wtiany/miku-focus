FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.cjs netease.cjs netease-auth.cjs netease-protocol.cjs netease.js index.html style.css app.js room.css room.js ./
COPY assets ./assets
ENV HOST=0.0.0.0 PORT=8642 NODE_ENV=production
EXPOSE 8642
USER node
CMD ["node", "server.cjs"]
