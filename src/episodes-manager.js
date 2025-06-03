// src/episodes-manager.js
import axios from "axios";
import path from "node:path";
import {
	promises as fs,
	createWriteStream,
	readdirSync,
	readFileSync,
} from "node:fs";
import JSONdb from "simple-json-db";

const EPISODES_JSON = path.join(process.cwd(), "episodes.json");
const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");
const SOUNDCLOUD_USER_URL = "https://soundcloud.com/lieven-scheire";

// --- Scraping Logic ---
export async function scrapeEpisodes() {
	const db = new JSONdb(EPISODES_JSON);
	let clientId = null;
	const userURL = SOUNDCLOUD_USER_URL;

	async function extractClientId() {
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
		for (const scriptURL of scriptUrls) {
			try {
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
						return clientId;
					}
				}
			} catch {}
		}
		throw new Error("Could not extract or find working client ID");
	}

	async function getUserInfo() {
		const response = await axios.get("https://api-v2.soundcloud.com/resolve", {
			params: {
				url: userURL,
				client_id: clientId,
			},
		});
		return response.data;
	}

	async function fetchAllTracks(userId) {
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
			nextUrl = data.next_href;
			if (nextUrl) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
		return allTracks;
	}

	async function getTrackDetails(trackId) {
		try {
			const response = await axios.get(
				`https://api-v2.soundcloud.com/tracks/${trackId}`,
				{
					params: { client_id: clientId },
				},
			);
			return response.data;
		} catch {
			return null;
		}
	}

	async function getStreamUrl(track) {
		try {
			if (track.stream_url) {
				const streamResponse = await axios.get(track.stream_url, {
					params: { client_id: clientId },
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
								params: { client_id: clientId },
							});
							if (mediaResponse.data.url) {
								return mediaResponse.data.url;
							}
						} catch {}
					}
				}
			}
			if (track.downloadable && track.download_url) {
				return `${track.download_url}?client_id=${clientId}`;
			}
			return null;
		} catch {
			return null;
		}
	}

	function extractChapters(description) {
		if (!description || typeof description !== "string") return [];
		const chapterRegex = /\((\d{2}):(\d{2}):(\d{2})\)\s*([^\n]+)/g;
		const chapters = Array.from(description.matchAll(chapterRegex)).map(
			([_, hh, mm, ss, title]) => ({
				start: `${hh}:${mm}:${ss}`,
				title: title.trim(),
			}),
		);
		return chapters;
	}

	function extractShowNotesUrl(description) {
		if (!description || typeof description !== "string") {
			return null;
		}
		const cleanDescription = description
			.replace(/<[^>]*>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		const urlPatterns = [
			/https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\n<>"]*\b/gi,
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
				} catch {}
			}
		}
		return null;
	}

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

	async function processTrackData(tracks) {
		const processedStreams = [];
		for (let i = 0; i < tracks.length; i++) {
			const track = tracks[i];
			const detailedTrack = (await getTrackDetails(track.id)) || track;
			let streamUrl = null;
			if (detailedTrack.streamable) {
				streamUrl = await getStreamUrl(detailedTrack);
			} else {
				continue;
			}
			const showNotesUrl = extractShowNotesUrl(detailedTrack.description);
			const chapters = extractChapters(detailedTrack.description);
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
				chapters: chapters.length > 0 ? chapters : undefined,
			};
			await upsertEpisode(processedTrack);
			processedStreams.push(processedTrack);
		}
		return processedStreams.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		);
	}

	await extractClientId();
	const userInfo = await getUserInfo();
	const allTracks = await fetchAllTracks(userInfo.id);
	await processTrackData(allTracks);
}

// --- Download Logic ---
export async function downloadEpisodes() {
	await ensureDownloadsDir();
	const db = new JSONdb(EPISODES_JSON);
	const episodes = db.get("episodes") || [];
	const episodesToDownload = [];
	for (const episode of episodes) {
		const filename = createEpisodeFilename(episode);
		const filePath = path.join(DOWNLOADS_DIR, filename);
		try {
			await fs.access(filePath);
			continue;
		} catch {
			if (!episode.streamUrl) continue;
			episodesToDownload.push(episode);
		}
	}
	for (const episode of episodesToDownload) {
		await downloadAudio(episode.streamUrl, episode);
	}
}

// --- Utility: Download a single audio file ---
export async function downloadAudio(streamUrl, trackData) {
	await ensureDownloadsDir();
	const filename = createEpisodeFilename(trackData);
	const filePath = path.join(DOWNLOADS_DIR, filename);
	try {
		await fs.access(filePath);
		return filePath;
	} catch {}
	const response = await axios({
		method: "GET",
		url: streamUrl,
		responseType: "stream",
		timeout: 60000,
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
	});
	const writer = createWriteStream(filePath);
	response.data.pipe(writer);
	return new Promise((resolve, reject) => {
		writer.on("finish", () => resolve(filePath));
		writer.on("error", reject);
	});
}

// --- Utility: Create episode filename ---
export function createEpisodeFilename(episode) {
	const sanitizedTitle = episode.title
		.replace(/[<>:"/\\|?*]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.substring(0, 200);
	const timestampPrefix = episode.createdAt
		? episode.createdAt
				.replace(/T/, "_")
				.replace(/:/g, "-")
				.replace(/Z$/, "")
				.replace(/\.\d+/, "")
		: null;
	return `${timestampPrefix}_${sanitizedTitle}_${episode.id}.mp3`;
}

// --- Utility: Load all episodes from DB ---
export function loadEpisodes() {
	const db = new JSONdb(EPISODES_JSON);
	return db.get("episodes") || [];
}

// --- Utility: Ensure downloads dir exists ---
export async function ensureDownloadsDir() {
	await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
}
