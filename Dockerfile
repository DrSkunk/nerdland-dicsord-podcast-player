# Use official Node.js LTS image
FROM node:22.16-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if present)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Set environment variables (override in docker run or .env file)
# ENV DISCORD_TOKEN=your_token
# ENV GUILD_ID=your_guild_id
# ENV VOICE_CHANNEL_ID=your_voice_channel_id

# Start the bot
CMD ["node", "src/index.js"]
