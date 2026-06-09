FROM node:20-slim

# Install FFmpeg and international fonts so Hindi/Devanagari characters render perfectly
RUN apt-get update && \
    apt-get install -y ffmpeg fontconfig fonts-noto fonts-indic && \
    fc-cache -f -v && \
    rm -rf /var/lib/apt/lists/*

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

WORKDIR /app/server
CMD ["node", "index.js"]
