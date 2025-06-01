import axios from "axios";

/**
 * Ask a question to the Nerdland Assistant API and return the answer as a Discord embed object.
 * @param {string} question - The user's question
 * @returns {Promise<string>} - The assistant's answer
 */
export async function askNerdlandAssistant(question) {
	const url = "https://assistent.nerdland.be/api/chat/stream";
	const payload = {
		Query: question,
		Model: "gpt-4o",
		Stream: true,
	};
	const headers = {
		accept: "*/*",
		"content-type": "application/json",
		origin: "https://assistent.nerdland.be",
		referer: "https://assistent.nerdland.be/",
	};
	const response = await axios.post(url, payload, { headers });

	const removeDocTags = (text) => text.replace(/\[doc\d+\]/g, "");

	if (typeof response.data === "string") {
		// Split on double newlines (or more) to get each data block
		const blocks = response.data
			.split(/\n{2,}/)
			.filter((b) => b.trim().startsWith("data: "));
		if (blocks.length > 0) {
			const jsonObjects = blocks
				.map((block) => {
					try {
						return JSON.parse(block.replace(/^data: /, ""));
					} catch (e) {
						return null;
					}
				})
				.filter(Boolean);

			const content = jsonObjects
				.map((obj) => removeDocTags(obj.choices?.[0]?.delta?.content || ""))
				.join("");

			return content;
		}
		return "[Geen antwoord ontvangen]";
	}
	return (
		removeDocTags(response.data?.choices?.[0]?.delta?.content) ||
		"[Geen antwoord ontvangen]"
	);
}
