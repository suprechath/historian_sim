# Stage 1: Build the React Single Page Application
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci || npm install

# Copy source and build
COPY . .
RUN npm run build

# Stage 2: Production Nginx web server
FROM nginx:alpine

# Clean default web root
RUN rm -rf /usr/share/nginx/html/*

# Copy compiled SPA assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy Nginx configuration with reverse proxy for /ui and SSE support
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
