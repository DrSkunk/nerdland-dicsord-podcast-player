import axios from "axios";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSONdb from "simple-json-db";

/**
 * Episode Download Script
 * Downloads MP3 files from SoundCloud using stored stream URLs
 * Note: Stream URLs are temporary and must be used soon after scraping
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new JSONdb(path.join(__dirname, "..", "episodes.json"));

const downloadDir = path.join(__dirname, "..", "downloads");
// Create download directory if it doesn't exist
await fs.mkdir(downloadDir, { recursive: true });

function createEpisodeFilename(episode) {
	// Sanitize title
	const sanitizedTitle = episode.title
		.replace(/[<>:"/\\|?*]/g, "") // Remove invalid characters
		.replace(/\s+/g, " ") // Replace multiple spaces with single space
		.trim()
		.substring(0, 200); // Limit length

	// Format timestamp
	const timestampPrefix = episode.createdAt
		? episode.createdAt
				.replace(/T/, "_") // Replace T with underscore
				.replace(/:/g, "-") // Replace colons with dashes
				.replace(/Z$/, "") // Remove trailing Z
				.replace(/\.\d+/, "") // Remove milliseconds if present
		: null;

	return `${timestampPrefix}_${sanitizedTitle}_${episode.id}.mp3`;
}

async function downloadAudio(streamUrl, trackData) {
	try {
		const filename = createEpisodeFilename(trackData);
		const filePath = path.join(downloadDir, filename);

		// Check if file already exists
		try {
			await fs.access(filePath);
			console.log(`⏭️  Skipping ${filename} (already exists)`);
			return filePath;
		} catch (error) {
			// File doesn't exist, proceed with download
		}

		console.log(`⬇️  Downloading: ${filename}`);

		const response = await axios({
			method: "GET",
			url: streamUrl,
			responseType: "stream",
			timeout: 60000, // 60 second timeout
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			},
		});

		const writer = createWriteStream(filePath);
		response.data.pipe(writer);

		return new Promise((resolve, reject) => {
			let downloadedBytes = 0;
			const totalBytes = Number.parseInt(
				response.headers["content-length"] || "0",
				10,
			);

			response.data.on("data", (chunk) => {
				downloadedBytes += chunk.length;
				if (totalBytes > 0) {
					const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
					process.stdout.write(
						`\r   📊 Progress: ${progress}% (${(
							downloadedBytes / 1024 / 1024
						).toFixed(1)}MB/${(totalBytes / 1024 / 1024).toFixed(1)}MB)`,
					);
				}
			});

			writer.on("finish", () => {
				process.stdout.write("\n");
				console.log(`✅ Downloaded: ${filename}`);
				resolve(filePath);
			});

			writer.on("error", (error) => {
				console.error(`\n❌ Download failed for ${filename}:`, error.message);
				reject(error);
			});
		});
	} catch (error) {
		console.error(`❌ Failed to download ${trackData.title}: ${error.message}`);
		return null;
	}
}

// get all episodes from the database
const episodes = db.get("episodes") || [];
// Filter out episodes that have already been downloaded
console.log(`📋 Found ${episodes.length} episodes in the database.`);

// Check which episodes need to be downloaded (async operation)
const episodesToDownload = [];
const episodesWithoutStreamUrl = [];

for (const episode of episodes) {
	const filename = createEpisodeFilename(episode);
	const filePath = path.join(downloadDir, filename);

	try {
		await fs.access(filePath);
		console.log(`⏭️  File already exists: ${filename}`);
		// File exists, don't add to download list
	} catch (error) {
		if (!episode.streamUrl) {
			episodesWithoutStreamUrl.push(episode);
			console.log(`⚠️  Episode missing stream URL: ${filename}`);
		} else {
			console.log(`📥 File needs download: ${filename}`);
			episodesToDownload.push(episode);
		}
	}
}

if (episodesWithoutStreamUrl.length > 0) {
	console.log(
		`⚠️  Warning: ${episodesWithoutStreamUrl.length} episodes don't have stream URLs.`,
	);
	console.log(
		`   Run 'npm run scrape-episodes' to get fresh stream URLs, then try downloading again.`,
	);
}

console.log(`📥 Found ${episodesToDownload.length} episodes to download.`);
for (const episode of episodesToDownload) {
	const streamUrl = episode.streamUrl;

	await downloadAudio(streamUrl, episode);
}
console.log("✅ All downloads complete.");
