import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import ffmpegPath from "ffmpeg-static";

/**
 * Create a PassThrough stream from an audio file at a given timestamp using ffmpeg.
 * @param {string} filePath - Path to the audio file
 * @param {number} seekSeconds - Number of seconds to seek into the file
 * @returns {PassThrough} - Stream of the audio starting at the given timestamp
 */
export function createFfmpegStream(filePath, seekSeconds) {
	if (!ffmpegPath || typeof ffmpegPath !== "string") {
		throw new Error("ffmpeg-static path not found");
	}
	const args = [
		"-ss",
		String(seekSeconds),
		"-i",
		filePath,
		"-f",
		"mp3",
		"-acodec",
		"libmp3lame",
		"-vn",
		"-",
	];
	const ffmpeg = spawn(ffmpegPath, args, {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const stream = new PassThrough();
	ffmpeg.stdout.pipe(stream);
	ffmpeg.on("error", (err) => {
		stream.destroy(err);
		ffmpeg.kill(); // Ensure the ffmpeg process is terminated
	});

	stream.on("close", () => {
		ffmpeg.kill(); // Clean up the ffmpeg process when the stream is closed
	});
	ffmpeg.on("close", (code) => {
		if (code !== 0) {
			stream.destroy(new Error(`ffmpeg exited with code ${code}`));
		} else {
			stream.end();
		}
	});
	return stream;
}
