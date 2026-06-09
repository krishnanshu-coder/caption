FROM node:20-slim

WORKDIR /app

# Copy and install dependencies first (better caching)
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

# Copy rest of the project
COPY server/ ./server/
COPY public/ ./public/

# Create uploads dir
RUN mkdir -p server/uploads

EXPOSE 3000

CMD ["node", "server/index.js"]
