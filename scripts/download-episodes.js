import { downloadEpisodes } from "../src/episodes-manager.js";

/**
 * Episode Download Script
 * Downloads MP3 files from SoundCloud using stored stream URLs
 * Note: Stream URLs are temporary and must be used soon after scraping
 */

// Main execution
async function main() {
	try {
		console.log("📥 Downloading all episodes with stream URLs...");
		await downloadEpisodes();
		console.log("✅ All downloads complete.");
	} catch (error) {
		console.error("❌ Download script failed:", error);
		process.exit(1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
