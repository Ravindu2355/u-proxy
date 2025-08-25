# Use Node.js 18 slim base image
FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and install deps
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy app source
COPY . .

# Expose server port
EXPOSE 8000

# Start the app
CMD ["node", "s.js"]
