FROM node:20-slim

# Install FFmpeg to process and export the MP4 video
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy and install dependencies
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

# Copy rest of the project
COPY server/ ./server/
COPY public/ ./public/

# Create uploads dir
RUN mkdir -p server/uploads

EXPOSE 3000

WORKDIR /app/server
CMD ["node", "index.js"]
