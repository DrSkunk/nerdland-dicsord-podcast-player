import DiscordBot from "./discord-bot.js";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID ?? null;

if (!TOKEN) {
	console.error("❌ DISCORD_TOKEN is required in .env file");
	process.exit(1);
}

console.log("🎵 Starting Nerdland Discord Podcast Player...");

// Create and start the Discord bot
const bot = new DiscordBot(TOKEN, GUILD_ID, VOICE_CHANNEL_ID);
bot.start().catch((error) => {
	console.error("❌ Failed to start bot:", error);
	process.exit(1);
});

// Graceful shutdown
async function handleShutdown(signal) {
	console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
	await bot.stop();
	process.exit(0);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
