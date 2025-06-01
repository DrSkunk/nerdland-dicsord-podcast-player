import axios from "axios";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSONdb from "simple-json-db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Module-level variables ---
const baseURL = "https://soundcloud.com";
const userURL = "https://soundcloud.com/lieven-scheire";
let clientId = null;
const dbPath = path.join(__dirname, "..", "episodes.json");
let db = null;

/**
 * Initialize JSON database
 */
async function initializeDatabase() {
	db = new JSONdb(dbPath);
	if (!db.has("episodes")) {
		db.set("episodes", []);
	}
	console.log("📊 Connected to JSON database");
	console.log("✅ Episodes database ready");
}

/**
 * Check if episode already exists in database
 */
async function episodeExists(permalink) {
	const episodes = db.get("episodes") || [];
	const existingEpisode = episodes.find(
		(episode) => episode.permalink === permalink,
	);
	return existingEpisode || null;
}

/**
 * Insert or update episode in database
 */
async function upsertEpisode(episodeData) {
	const episodes = db.get("episodes") || [];
	const existingIndex = episodes.findIndex(
		(episode) => episode.id === episodeData.id,
	);
	episodeData.updated_date = new Date().toISOString();
	if (existingIndex === -1) {
		episodeData.created_date = new Date().toISOString();
	}
	if (existingIndex !== -1) {
		episodes[existingIndex] = { ...episodes[existingIndex], ...episodeData };
	} else {
		episodes.push(episodeData);
	}
	db.set("episodes", episodes);
	return episodeData.id;
}

/**
 * Extract client ID from SoundCloud's JavaScript files
 */
async function extractClientId() {
	console.log("🔍 Extracting SoundCloud client ID...");
	const response = await axios.get(userURL, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
	});
	const html = response.data;
	const scriptPatterns = [
		/<script.*?src="([^"]*app[^"]*\.js)"[^>]*>/g,
		/<script.*?src="([^"]*vendor[^"]*\.js)"[^>]*>/g,
		/<script.*?src="([^"]*main[^"]*\.js)"[^>]*>/g,
		/<script.*?crossorigin.*?src="([^"]+)"[^>]*>/g,
	];
	let scriptUrls = [];
	for (const pattern of scriptPatterns) {
		let match = pattern.exec(html);
		while (match !== null) {
			let scriptUrl = match[1];
			if (scriptUrl.startsWith("//")) {
				scriptUrl = `https:${scriptUrl}`;
			} else if (scriptUrl.startsWith("/")) {
				scriptUrl = `https://soundcloud.com${scriptUrl}`;
			}
			scriptUrls.push(scriptUrl);
			match = pattern.exec(html);
		}
	}
	scriptUrls = [...new Set(scriptUrls)];
	console.log(`📜 Found ${scriptUrls.length} script files to check`);
	for (const scriptURL of scriptUrls) {
		try {
			console.log(`🔍 Checking: ${scriptURL.split("/").pop()}`);
			const scriptResponse = await axios.get(scriptURL, {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				},
			});
			const clientIdPatterns = [
				/client_id:"([a-zA-Z0-9]+)"/,
				/client_id:\"([a-zA-Z0-9]+)\"/,
				/clientId:"([a-zA-Z0-9]+)"/,
				/clientId:\"([a-zA-Z0-9]+)\"/,
				/"client_id":"([a-zA-Z0-9]+)"/,
				/client_id=([a-zA-Z0-9]+)/,
			];
			for (const pattern of clientIdPatterns) {
				const clientIdMatch = scriptResponse.data.match(pattern);
				if (clientIdMatch) {
					clientId = clientIdMatch[1];
					console.log("✅ Client ID extracted successfully");
					return clientId;
				}
			}
		} catch (error) {
			console.log(
				`⚠️  Failed to fetch ${scriptURL.split("/").pop()}: ${error.message}`,
			);
		}
	}
	const fallbackClientIds = [
		"iZIs9mchVcX5lhVkN0b1WACJxt3kz3eh",
		"c9AadRMEwQKfnCLDJ8GBqvQvjQTdV0dP",
	];
	console.log(
		"⚠️  Could not extract client ID from scripts, trying fallback IDs...",
	);
	for (const fallbackId of fallbackClientIds) {
		try {
			await axios.get("https://api-v2.soundcloud.com/resolve", {
				params: {
					url: "https://soundcloud.com/discover",
					client_id: fallbackId,
				},
			});
			clientId = fallbackId;
			console.log("✅ Using fallback client ID");
			return clientId;
		} catch (error) {}
	}
	throw new Error("Could not extract or find working client ID");
}

/**
 * Get user information from SoundCloud API
 */
async function getUserInfo() {
	console.log("👤 Fetching user information...");
	const response = await axios.get("https://api-v2.soundcloud.com/resolve", {
		params: {
			url: userURL,
			client_id: clientId,
		},
	});
	return response.data;
}

/**
 * Fetch all tracks for a user with pagination
 */
async function fetchAllTracks(userId) {
	console.log("🎵 Fetching all tracks...");
	let allTracks = [];
	let nextUrl = `https://api-v2.soundcloud.com/users/${userId}/tracks`;
	while (nextUrl) {
		const response = await axios.get(nextUrl, {
			params: {
				client_id: clientId,
				limit: 200,
				linked_partitioning: 1,
			},
		});
		const data = response.data;
		allTracks = allTracks.concat(data.collection || []);
		console.log(
			`📥 Fetched ${data.collection?.length || 0} tracks (Total: ${allTracks.length})`,
		);
		nextUrl = data.next_href;
		if (nextUrl) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
	return allTracks;
}

/**
 * Get detailed track information including streaming data
 */
async function getTrackDetails(trackId) {
	try {
		const response = await axios.get(
			`https://api-v2.soundcloud.com/tracks/${trackId}`,
			{
				params: {
					client_id: clientId,
				},
			},
		);
		return response.data;
	} catch (error) {
		console.log(
			`⚠️  Could not get detailed track info for ${trackId}: ${error.message}`,
		);
		return null;
	}
}

/**
 * Get stream URL for a track - used for downloading, not real-time streaming
 */
async function getStreamUrl(track) {
	try {
		if (track.stream_url) {
			const streamResponse = await axios.get(track.stream_url, {
				params: {
					client_id: clientId,
				},
			});
			if (streamResponse.data.url) {
				return streamResponse.data.url;
			}
		}
		if (track.media?.transcodings && track.media.transcodings.length > 0) {
			for (const transcoding of track.media.transcodings) {
				if (
					transcoding.format &&
					transcoding.format.protocol === "progressive"
				) {
					try {
						const mediaResponse = await axios.get(transcoding.url, {
							params: {
								client_id: clientId,
							},
						});
						if (mediaResponse.data.url) {
							return mediaResponse.data.url;
						}
					} catch (error) {}
				}
			}
		}
		if (track.downloadable && track.download_url) {
			return `${track.download_url}?client_id=${clientId}`;
		}
		return null;
	} catch (error) {
		console.log(
			`⚠️  Could not get stream URL for track ${track.id}: ${error.message}`,
		);
		return null;
	}
}

/**
 * Process and format track data with database integration
 */
async function processTrackData(tracks) {
	console.log("🔄 Processing track data...");
	const processedStreams = [];
	for (let i = 0; i < tracks.length; i++) {
		const track = tracks[i];
		console.log(
			`📦 Processing track ${i + 1}/${tracks.length}: ${track.title}`,
		);
		const detailedTrack = (await getTrackDetails(track.id)) || track;
		let streamUrl = null;
		if (detailedTrack.streamable) {
			streamUrl = await getStreamUrl(detailedTrack);
		} else {
			console.log(`⚠️  Track ${detailedTrack.id} is not streamable, skipping`);
			continue;
		}
		const showNotesUrl = extractShowNotesUrl(detailedTrack.description);
		if (showNotesUrl) {
			console.log(`📝 Found show notes URL: ${showNotesUrl}`);
		}
		const processedTrack = {
			id: detailedTrack.id,
			title: detailedTrack.title,
			description: detailedTrack.description,
			duration: detailedTrack.duration,
			durationFormatted: formatDuration(detailedTrack.duration),
			createdAt: detailedTrack.created_at,
			permalink: detailedTrack.permalink_url,
			streamUrl: streamUrl,
			showNotes: showNotesUrl,
		};
		await upsertEpisode(processedTrack);
		processedStreams.push(processedTrack);
	}
	return processedStreams.sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
}

/**
 * Format duration from milliseconds to readable format
 */
function formatDuration(milliseconds) {
	if (!milliseconds) return "Unknown";
	const seconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) {
		return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
	}
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Sanitize filename for safe file system usage
 */
function sanitizeFilename(filename) {
	return filename
		.replace(/[<>:"/\\|?*]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.substring(0, 200);
}

/**
 * Main scraping function - collects metadata and stream URLs for downloading
 */
async function scrapeAllStreams(limit) {
	try {
		console.log("🚀 Starting SoundCloud metadata and stream URL scraping...");
		console.log(`📍 Target URL: ${userURL}`);
		if (limit) {
			console.log(`🔢 Limiting to ${limit} tracks for testing`);
		}
		await initializeDatabase();
		await extractClientId();
		const userInfo = await getUserInfo();
		console.log(`👤 User: ${userInfo.username} (${userInfo.full_name})`);
		console.log(`📊 Public tracks: ${userInfo.public_favorites_count}`);
		const allTracks = await fetchAllTracks(userInfo.id);
		const tracks = limit ? allTracks.slice(0, limit) : allTracks;
		const processedStreams = await processTrackData(tracks);
		console.log("✅ Metadata and stream URL scraping completed successfully!");
		console.log(`📈 Total episodes found: ${processedStreams.length}`);
		displaySummary(processedStreams);
		return processedStreams;
	} catch (error) {
		console.error("💥 Scraping failed:", error.message);
		throw error;
	}
}

/**
 * Display a summary of scraped episode metadata
 */
function displaySummary(streams) {
	console.log("\n📋 SUMMARY:");
	console.log("=".repeat(50));
	if (streams.length === 0) {
		console.log("No episodes found.");
		return;
	}
	const totalDuration = streams.reduce(
		(sum, stream) => sum + (stream.duration || 0),
		0,
	);
	const avgDuration = totalDuration / streams.length;
	const showNotesCount = streams.filter((stream) => stream.showNotes).length;
	console.log(`📊 Total Episodes: ${streams.length}`);
	console.log(`⏱️  Total Duration: ${formatDuration(totalDuration)}`);
	console.log(`📊 Average Duration: ${formatDuration(avgDuration)}`);
	console.log(
		`📝 Episodes with Show Notes: ${showNotesCount}/${streams.length} (${((showNotesCount / streams.length) * 100).toFixed(1)}%)`,
	);
	console.log(
		`🔗 Episodes with Stream URLs: ${streams.filter((s) => s.streamUrl).length}/${streams.length} (for downloading)`,
	);
	console.log("\n🆕 Latest 5 Episodes:");
	streams.slice(0, 5).forEach((stream, index) => {
		const downloadStatus = stream.streamUrl ? "📥" : "❌";
		const showNotesStatus = stream.showNotes ? "📝" : "⭕";
		console.log(
			`${index + 1}. ${stream.title} (${stream.durationFormatted}) ${downloadStatus} ${showNotesStatus}`,
		);
	});
	console.log("\n🔗 Data saved to episodes.json");
	console.log(
		"💡 Run `npm run download-episodes` to download audio files for local playback",
	);
}

/**
 * Extract show notes URL from track description
 */
function extractShowNotesUrl(description) {
	if (!description || typeof description !== "string") {
		return null;
	}
	const cleanDescription = description
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const patterns = [
		/(?:show\s*notes?|shownotes?)[\s:]*([^\s\n]+(?:\s+[^\s\n]+)*?)(?:\s|$)/i,
		/(?:meer\s+info|more\s+info)[\s:]*(?:op[\s:]*)?([^\s\n]+(?:\s+[^\s\n]+)*?)(?:\s|$)/i,
	];
	for (const pattern of patterns) {
		const matches = cleanDescription.match(pattern);
		if (matches && matches.length > 1) {
			let url = matches[1].trim();
			url = url.replace(/[.,;!?]+$/, "");
			url = url.replace(/\s+(en|and|of|or|\w{1,3})$/, "");
			if (
				url.length < 8 ||
				/^(op|met|door|aan|van|in|en|and|or|the|a|an)$/i.test(url)
			) {
				continue;
			}
			if (url && !url.startsWith("http")) {
				url = `https://${url}`;
			}
			try {
				const urlObj = new URL(url);
				if (urlObj.hostname.includes(".") && urlObj.hostname.length > 3) {
					return url;
				}
			} catch (error) {
				// skip invalid URL
			}
		}
	}
	const urlPatterns = [
		// Standard HTTP/HTTPS URLs - improved to avoid capturing incomplete URLs
		/https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\n<>"]*\b/gi,
		// Website patterns without protocol - improved validation
		/(?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?(?=\s|$)/g,
	];
	for (const urlPattern of urlPatterns) {
		const matches = cleanDescription.match(urlPattern);
		if (matches && matches.length > 0) {
			let url = matches[0];
			url = url.replace(/[.,;!?]+$/, "");
			if (url.length < 8) {
				continue;
			}
			if (url && !url.startsWith("http")) {
				url = `https://${url}`;
			}
			try {
				const urlObj = new URL(url);
				if (urlObj.hostname.includes(".") && urlObj.hostname.length > 3) {
					return url;
				}
			} catch (error) {
				// skip invalid URL
			}
		}
	}
	return null;
}

// Main execution
async function main() {
	try {
		console.log("🎯 Running SoundCloud metadata and stream URL scraping...");
		await scrapeAllStreams();
		console.log("🎉 Scraping completed successfully!");
		console.log(
			"💡 Next step: Run `npm run download-episodes` to download audio files",
		);
	} catch (error) {
		console.error("❌ Script failed:", error);
		process.exit(1);
	}
}

// Export for use in other modules
export {
	scrapeAllStreams,
	initializeDatabase,
	extractClientId,
	getUserInfo,
	fetchAllTracks,
	getTrackDetails,
	getStreamUrl,
	processTrackData,
	upsertEpisode,
	episodeExists,
	formatDuration,
	sanitizeFilename,
	extractShowNotesUrl,
};

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
