FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# Ensure proper permissions for node user
RUN chown node:node /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --chown=node:node . .

USER node

CMD ["node", "src/start.js"]