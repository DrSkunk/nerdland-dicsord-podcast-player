import { scrapeEpisodes } from "../src/episodes-manager.js";

// Main execution
async function main() {
	try {
		console.log("🎯 Running SoundCloud metadata and stream URL scraping...");
		await scrapeEpisodes();
		console.log("🎉 Scraping completed successfully!");
		console.log(
			"💡 Next step: Run `npm run download-episodes` to download audio files",
		);
	} catch (error) {
		console.error("❌ Script failed:", error);
		process.exit(1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
