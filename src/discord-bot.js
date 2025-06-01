import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Client,
	GatewayIntentBits,
	SlashCommandBuilder,
	Collection,
	EmbedBuilder,
	ActivityType,
} from "discord.js";
import {
	joinVoiceChannel,
	createAudioPlayer,
	createAudioResource,
	AudioPlayerStatus,
	VoiceConnectionStatus,
} from "@discordjs/voice";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default class DiscordBot {
	constructor(token, guildId, voiceChannelId) {
		this.token = token;
		this.guildId = guildId;
		// voiceChannelId can be null if not configured
		this.voiceChannelId = voiceChannelId;
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildVoiceStates,
				GatewayIntentBits.GuildMessages,
			],
		});

		this.player = createAudioPlayer();
		this.connection = null;
		this.currentEpisode = null;
		this.episodes = [];
		this.localFiles = [];
		this.commands = new Collection();

		this.loadData();
		this.setupEventHandlers();
		this.setupCommands();
	}

	loadData() {
		try {
			// Load episodes data
			const episodesPath = join(__dirname, "../episodes.json");
			const episodesData = JSON.parse(readFileSync(episodesPath, "utf8"));
			this.episodes = episodesData.episodes || [];

			// Load local MP3 files
			const downloadsPath = join(__dirname, "../downloads");
			this.localFiles = readdirSync(downloadsPath)
				.filter((file) => file.endsWith(".mp3"))
				.map((file) => ({
					filename: file,
					path: join(downloadsPath, file),
					title: this.getEpisodeTitle(file),
				}));

			console.log(
				`📚 Loaded ${this.episodes.length} episodes metadata and ${this.localFiles.length} local files`,
			);
		} catch (error) {
			console.error("❌ Error loading data:", error);
		}
	}

	getEpisodeTitle(filename) {
		// Extract episode ID from filename pattern: YYYY-MM-DD_HH-MM-SS_Title_ID.mp3
		const parts = filename.split("_");
		if (parts.length >= 2) {
			// Get the last part which contains the ID
			const lastPart = parts[parts.length - 1];
			const episodeId = Number.parseInt(lastPart.replace(".mp3", ""), 10);

			// Look up the real title from episodes.json database
			const episode = this.episodes.find((ep) => ep.id === episodeId);
			if (episode) {
				return episode.title;
			}
		}

		// Fallback to parsing filename if episode not found in database
		if (parts.length >= 3) {
			return parts.slice(2, -1).join("_").replace(".mp3", "");
		}
		return filename.replace(".mp3", "");
	}

	setupEventHandlers() {
		this.client.once("ready", async () => {
			console.log(`✅ Bot logged in as ${this.client.user?.tag}`);

			// Set initial bot activity
			this.updateBotActivity("Nerdland Podcast Player");

			// Auto-start playing when bot is ready
			await this.autoStartPlayback();
		});

		this.client.on("interactionCreate", async (interaction) => {
			if (interaction.isAutocomplete()) {
				await this.handleAutocomplete(interaction);
				return;
			}

			if (!interaction.isChatInputCommand()) return;

			try {
				await this.handleCommand(interaction);
			} catch (error) {
				console.error("❌ Error handling command:", error);
				const reply = {
					content:
						"❌ Er is een fout opgetreden tijdens het verwerken van je commando.",
					ephemeral: true,
				};

				if (interaction.replied || interaction.deferred) {
					await interaction.followUp(reply);
				} else {
					await interaction.reply(reply);
				}
			}
		});

		// Audio player event handlers
		this.player.on(AudioPlayerStatus.Playing, () => {
			console.log("🎵 Audio player started playing");
		});

		this.player.on(AudioPlayerStatus.Idle, () => {
			console.log("⏸️ Audio player became idle");
			// Reset activity to default when episode ends
			this.updateBotActivity("Nerdland Podcast Player");
			// Auto-play next random episode
			this.playRandomEpisode();
		});

		this.player.on("error", (error) => {
			console.error("❌ Audio player error:", error);
		});
	}

	setupCommands() {
		const commands = [
			new SlashCommandBuilder()
				.setName("podcast")
				.setDescription("Nerdland podcast speler commando's")
				.addSubcommand((subcommand) =>
					subcommand
						.setName("play")
						.setDescription(
							"Speel de nieuwste aflevering van de Nerdland podcast",
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName("stop")
						.setDescription("Stop de huidige aflevering"),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName("random")
						.setDescription(
							"Speel een willekeurige aflevering uit het Nerdland podcast archief",
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName("episode")
						.setDescription(
							"Speel een specifieke aflevering per maand of special",
						)
						.addStringOption((option) =>
							option
								.setName("episode")
								.setDescription("Kies een aflevering om af te spelen")
								.setRequired(true)
								.setAutocomplete(true),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName("shownotes")
						.setDescription("Toon de shownotes van de huidige aflevering"),
				),
		];

		this.commands = new Collection();
		for (const command of commands) {
			this.commands.set(command.name, command);
		}
	}

	async handleCommand(interaction) {
		const subcommand = interaction.options.getSubcommand();

		switch (subcommand) {
			case "play":
				await this.playLatestEpisode(interaction);
				break;
			case "stop":
				await this.stopPlayback(interaction);
				break;
			case "random":
				await this.playRandomEpisodeCommand(interaction);
				break;
			case "episode":
				await this.playSpecificEpisode(interaction);
				break;
			case "shownotes":
				await this.showEpisodeNotes(interaction);
				break;
			default:
				await interaction.reply({
					content: "❌ Onbekend commando",
					ephemeral: true,
				});
		}
	}

	/**
	 * Get the target voice channel for the bot to join
	 * @param {object} interaction - Discord interaction object
	 * @param {object} userVoiceChannel - User's current voice channel (fallback)
	 * @returns {Promise<object|null>} - Voice channel object or null
	 */
	async getTargetVoiceChannel(interaction, userVoiceChannel = null) {
		// If a specific voice channel ID is configured, use that
		if (this.voiceChannelId) {
			try {
				const guild = interaction.guild;
				const configuredChannel = await guild.channels.fetch(
					this.voiceChannelId,
				);

				if (configuredChannel?.isVoiceBased()) {
					console.log(
						`Using configured voice channel: ${configuredChannel.name}`,
					);
					return configuredChannel;
				}
				console.warn(
					`Configured voice channel ID ${this.voiceChannelId} not found or not a voice channel. Falling back to user's channel.`,
				);
			} catch (error) {
				console.error(
					`Error fetching configured voice channel ${this.voiceChannelId}:`,
					error,
				);
				console.warn("Falling back to user's voice channel.");
			}
		}

		// Fall back to user's voice channel
		return userVoiceChannel;
	}

	async playLatestEpisode(interaction) {
		if (!this.localFiles.length) {
			return await interaction.reply({
				content: "❌ Geen afleveringen beschikbaar",
				ephemeral: true,
			});
		}

		const member = interaction.member;
		const userVoiceChannel = member?.voice?.channel;

		// Get the target voice channel (configured or user's channel)
		const targetVoiceChannel = await this.getTargetVoiceChannel(
			interaction,
			userVoiceChannel,
		);

		if (!targetVoiceChannel) {
			return await interaction.reply({
				content:
					"❌ Geen spraakkanaal beschikbaar! Ga naar een spraakkanaal of configureer VOICE_CHANNEL_ID in je omgeving.",
				ephemeral: true,
			});
		}

		await interaction.deferReply();

		try {
			// Get the latest local file (assuming they're sorted by date)
			const latestFile = this.localFiles[this.localFiles.length - 1];

			await this.playLocalFile(
				latestFile,
				targetVoiceChannel,
				interaction,
				"latest",
			);
		} catch (error) {
			console.error("❌ Error playing latest episode:", error);
			await interaction.editReply({
				content: "❌ Kon de nieuwste aflevering niet afspelen",
			});
		}
	}

	async playRandomEpisodeCommand(interaction) {
		if (!this.localFiles.length) {
			return await interaction.reply({
				content: "❌ Geen afleveringen beschikbaar",
				ephemeral: true,
			});
		}

		const member = interaction.member;
		const userVoiceChannel = member?.voice?.channel;

		// Get the target voice channel (configured or user's channel)
		const targetVoiceChannel = await this.getTargetVoiceChannel(
			interaction,
			userVoiceChannel,
		);

		if (!targetVoiceChannel) {
			return await interaction.reply({
				content:
					"❌ Geen spraakkanaal beschikbaar! Ga naar een spraakkanaal of configureer VOICE_CHANNEL_ID in je omgeving.",
				ephemeral: true,
			});
		}

		await interaction.deferReply();

		try {
			const randomFile =
				this.localFiles[Math.floor(Math.random() * this.localFiles.length)];

			await this.playLocalFile(
				randomFile,
				targetVoiceChannel,
				interaction,
				"random",
			);
		} catch (error) {
			console.error("❌ Error playing random episode:", error);
			await interaction.editReply({
				content: "❌ Kon de willekeurige aflevering niet afspelen",
			});
		}
	}

	async playRandomEpisode() {
		// Auto-play next random episode (called when current episode ends)
		if (this.connection && this.localFiles.length > 0) {
			const randomFile =
				this.localFiles[Math.floor(Math.random() * this.localFiles.length)];
			console.log("🎲 Auto-playing random episode:", randomFile.title);
			// Get the voice channel from the current connection
			const voiceChannel = this.connection.joinConfig.channelId
				? this.client.channels.cache.get(this.connection.joinConfig.channelId)
				: null;
			await this.playLocalFile(randomFile, voiceChannel, null, "playing");
		}
	}

	findEpisodeData(filename) {
		// Try to match local file with episode metadata
		const id = filename.match(/_(\d+)\.mp3$/)?.[1];
		if (id) {
			return this.episodes.find((ep) => ep.id.toString() === id);
		}
		return null;
	}

	/**
	 * Play a local audio file
	 * @param {object} fileData - The file data object
	 * @param {object} voiceChannel - The voice channel to join
	 * @param {object|null} interaction - Discord interaction object with editReply method
	 * @param {string} embedType - The type of embed to create
	 */
	async playLocalFile(
		fileData,
		voiceChannel,
		interaction = null,
		embedType = "playing",
	) {
		try {
			// Join voice channel if not already connected
			if (voiceChannel && !this.connection) {
				this.connection = joinVoiceChannel({
					channelId: voiceChannel.id,
					guildId: voiceChannel.guild.id,
					adapterCreator: voiceChannel.guild.voiceAdapterCreator,
				});

				this.connection.on(VoiceConnectionStatus.Ready, () => {
					console.log("✅ Voice connection is ready");
				});

				this.connection.on(VoiceConnectionStatus.Disconnected, () => {
					console.log("❌ Voice connection disconnected");
					this.connection = null;
				});
			}

			// Create audio resource from local file
			const resource = createAudioResource(fileData.path);
			this.player.play(resource);

			if (this.connection) {
				this.connection.subscribe(this.player);
			}

			this.currentEpisode = fileData;
			console.log("-----------------", fileData);
			// remove "Nerdland Maandoverzicht: " and "Nerdland Special: " from title
			const activity = fileData.title
				.replace("Nerdland Maandoverzicht:", "")
				.replace("Nerdland Special:", "")
				.trim();
			console.log(`🎵 Playing local file: ${activity}`);
			this.updateBotActivity(activity);

			// Send embed if interaction is provided and has editReply method
			if (interaction?.editReply) {
				const embed = this.createEpisodeEmbed(fileData, embedType);
				await interaction.editReply({ embeds: [embed] });
			}
		} catch (error) {
			console.error("❌ Error playing local file:", error);
			throw error;
		}
	}

	async stopPlayback(interaction) {
		if (!this.player || this.player.state.status === AudioPlayerStatus.Idle) {
			return await interaction.reply({
				content: "❌ Er wordt momenteel geen audio afgespeeld",
				ephemeral: true,
			});
		}

		this.player.stop();
		this.currentEpisode = null;

		if (this.connection) {
			this.connection.destroy();
			this.connection = null;
		}

		// Reset bot activity when playback stops
		this.updateBotActivity("Nerdland Podcast Player");

		const embed = new EmbedBuilder()
			.setColor(0xff6b6b)
			.setTitle("⏹️ Afspelen Gestopt")
			.setDescription("De podcast is gestopt");

		await interaction.reply({ embeds: [embed] });
	}

	async showEpisodeNotes(interaction) {
		if (!this.currentEpisode) {
			return await interaction.reply({
				content: "❌ Er wordt momenteel geen aflevering afgespeeld",
				ephemeral: true,
			});
		}

		const episodeData = this.findEpisodeData(this.currentEpisode.filename);

		if (!episodeData) {
			return await interaction.reply({
				content: "❌ Geen shownotes beschikbaar voor deze aflevering",
				ephemeral: true,
			});
		}

		// Use showNotes field if available, otherwise fall back to permalink
		const showNotesUrl = episodeData.showNotes || episodeData.permalink;

		await interaction.reply({ content: showNotesUrl });
	}

	async handleAutocomplete(interaction) {
		const focusedOption = interaction.options.getFocused();
		const query = focusedOption.toLowerCase();

		// Get categorized episodes for autocomplete
		const monthlyEpisodes = this.getMonthlyEpisodes();
		const specialEpisodes = this.getSpecialEpisodes();

		const choices = [];

		// Add monthly episodes (most recent first)
		const filteredMonthly = monthlyEpisodes
			.filter((ep) => ep.title.toLowerCase().includes(query))
			.slice(0, 15); // Limit to avoid hitting Discord's 25 choice limit
		for (const ep of filteredMonthly) {
			choices.push({
				name: ep.title,
				value: ep.id.toString(),
			});
		}

		// Add special episodes if we have room
		const remainingSlots = 25 - choices.length;
		if (remainingSlots > 0) {
			const filteredSpecial = specialEpisodes
				.filter((ep) => ep.title.toLowerCase().includes(query))
				.slice(0, remainingSlots);
			for (const ep of filteredSpecial) {
				choices.push({
					name: ep.title,
					value: ep.id.toString(),
				});
			}
		}

		await interaction.respond(choices);
	}

	async playSpecificEpisode(interaction) {
		const episodeId = interaction.options.getString("episode");

		if (!episodeId) {
			return await interaction.reply({
				content: "❌ Geen aflevering geselecteerd",
				ephemeral: true,
			});
		}

		// Find the episode in our database
		const episodeData = this.episodes.find(
			(ep) => ep.id.toString() === episodeId,
		);
		if (!episodeData) {
			return await interaction.reply({
				content: "❌ Aflevering niet gevonden in database",
				ephemeral: true,
			});
		}

		// Find corresponding local file
		const localFile = this.localFiles.find((file) => {
			const fileId = file.filename.match(/_(\d+)\.mp3$/)?.[1];
			return fileId === episodeId;
		});

		if (!localFile) {
			return await interaction.reply({
				content:
					"❌ Afleveringsbestand niet lokaal gevonden. Download de aflevering eerst met `npm run download-episodes`.",
				ephemeral: true,
			});
		}

		const member = interaction.member;
		const userVoiceChannel = member?.voice?.channel;

		// Get the target voice channel (configured or user's channel)
		const targetVoiceChannel = await this.getTargetVoiceChannel(
			interaction,
			userVoiceChannel,
		);

		if (!targetVoiceChannel) {
			return await interaction.reply({
				content:
					"❌ Geen spraakkanaal beschikbaar! Ga naar een spraakkanaal of configureer VOICE_CHANNEL_ID in je omgeving.",
				ephemeral: true,
			});
		}

		await interaction.deferReply();

		try {
			await this.playLocalFile(
				localFile,
				targetVoiceChannel,
				interaction,
				"specific",
			);
		} catch (error) {
			console.error("❌ Error playing specific episode:", error);
			await interaction.editReply({
				content: "❌ Kon de geselecteerde aflevering niet afspelen",
			});
		}
	}

	getMonthlyEpisodes() {
		return this.episodes
			.filter((ep) => ep.title.includes("Nerdland Maandoverzicht:"))
			.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			); // Most recent first
	}

	getSpecialEpisodes() {
		return this.episodes
			.filter((ep) => ep.title.includes("Nerdland Special:"))
			.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			); // Most recent first
	}

	/**
	 * Auto-start playback when the bot is ready (no interaction required)
	 */
	async autoStartPlayback() {
		try {
			console.log("🎵 Attempting to auto-start playback...");

			// Check if we have episodes available
			if (!this.localFiles.length) {
				console.log("❌ No episodes available for auto-start");
				return;
			}

			// Get the configured voice channel
			const targetVoiceChannel = await this.getConfiguredVoiceChannel();

			if (!targetVoiceChannel) {
				console.log(
					"❌ No voice channel configured for auto-start. Set VOICE_CHANNEL_ID in your .env file",
				);
				return;
			}

			// Get the latest local file (assuming they're sorted by date)
			const latestFile = this.localFiles[this.localFiles.length - 1];
			console.log(`🎵 Auto-starting with latest episode: ${latestFile.title}`);

			await this.playLocalFile(latestFile, targetVoiceChannel);

			console.log("✅ Auto-playback started successfully");
		} catch (error) {
			console.error("❌ Error during auto-start playback:", error);
		}
	}

	/**
	 * Get the configured voice channel (for auto-start, no interaction needed)
	 */
	async getConfiguredVoiceChannel() {
		if (!this.voiceChannelId) {
			return null;
		}

		try {
			// Get the guild from the configured guild ID
			const guild = this.client.guilds.cache.get(this.guildId);
			if (!guild) {
				console.error(`Guild ${this.guildId} not found`);
				return null;
			}

			const configuredChannel = await guild.channels.fetch(this.voiceChannelId);

			if (configuredChannel?.isVoiceBased()) {
				console.log(
					`Using configured voice channel: ${configuredChannel.name}`,
				);
				return configuredChannel;
			}
			console.warn(
				`Configured voice channel ID ${this.voiceChannelId} not found or not a voice channel`,
			);
			return null;
		} catch (error) {
			console.error(
				`Error fetching configured voice channel ${this.voiceChannelId}:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Update the bot's activity status to show the currently playing episode
	 * @param {string} episodeTitle - The title of the currently playing episode
	 */
	updateBotActivity(episodeTitle) {
		try {
			if (this.client.user) {
				this.client.user.setActivity(episodeTitle, {
					type: ActivityType.Listening,
				});
				console.log(`🎵 Updated bot activity: Listening to ${episodeTitle}`);
			}
		} catch (error) {
			console.error("❌ Error updating bot activity:", error);
		}
	}

	async registerCommands() {
		if (!this.guildId) {
			console.log("📝 Registering global commands...");
			if (this.client.application) {
				await this.client.application.commands.set([...this.commands.values()]);
			}
		} else {
			console.log(`📝 Registering guild commands for ${this.guildId}...`);
			const guild = this.client.guilds.cache.get(this.guildId);
			if (guild) {
				await guild.commands.set([...this.commands.values()]);
			}
		}
		console.log("✅ Commands registered successfully");
	}

	async start() {
		await this.client.login(this.token);
		await this.registerCommands();
	}

	async stop() {
		if (this.player) {
			this.player.stop();
		}

		if (this.connection) {
			this.connection.destroy();
		}

		await this.client.destroy();
		console.log("✅ Bot stopped successfully");
	}

	/**
	 * Create an embed for the currently playing episode
	 * @param {object} fileData - The file data object
	 * @param {string} embedType - The type of embed ('latest', 'random', 'specific')
	 * @returns {EmbedBuilder} - The created embed
	 */
	createEpisodeEmbed(fileData, embedType = "playing") {
		const episodeData = this.findEpisodeData(fileData.filename);

		let color;
		let title;
		switch (embedType) {
			case "latest":
				color = 0x00ae86;
				title = "🎵 Nu Aan Het Spelen: Nieuwste Aflevering";
				break;
			case "random":
				color = 0x9932cc;
				title = "🎲 Nu Aan Het Spelen: Willekeurige Aflevering";
				break;
			case "specific":
				color = 0x6a5acd;
				title = "🎯 Nu Aan Het Spelen: Geselecteerde Aflevering";
				break;
			default:
				color = 0x00ae86;
				title = "🎵 Nu Aan Het Spelen";
		}

		const embed = new EmbedBuilder()
			.setColor(color)
			.setTitle(title)
			.setDescription(`**${fileData.title}**`);

		// Add duration for specific episodes
		if (embedType === "specific" && episodeData?.durationFormatted) {
			embed.addFields({
				name: "⏱️ Duur",
				value: episodeData.durationFormatted,
				inline: true,
			});
		}

		if (episodeData?.permalink) {
			embed.setURL(episodeData.permalink);
		}

		// Use showNotes if available for specific episodes
		if (embedType === "specific" && episodeData?.showNotes) {
			embed.setURL(episodeData.showNotes);
		}

		return embed;
	}
}
