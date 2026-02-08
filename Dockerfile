FROM node:22-slim

# Install LibreOffice for DOCX→PDF conversion, and other utils
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libreoffice-writer \
      poppler-utils \
      jq \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --production=false

# Copy source
COPY . .

# Build the Mastra project
RUN npm run build

# Production environment
ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

# Run the built Mastra output
CMD ["sh", "-c", "cd .mastra/output && node index.mjs"]
