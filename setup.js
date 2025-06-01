#!/usr/bin/env node

// Quick setup script for the Nerdland Discord Podcast Player
import { existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🚀 Nerdland Discord Podcast Player - Quick Setup\n');

// Check if .env exists
const envPath = join(__dirname, '.env');
const envExamplePath = join(__dirname, '.env.example');

if (!existsSync(envPath)) {
    if (existsSync(envExamplePath)) {
        try {
            copyFileSync(envExamplePath, envPath);
            console.log('✅ Created .env file from template');
            console.log('⚠️  Please edit .env and add your Discord bot token');
        } catch (error) {
            console.log('❌ Error creating .env file:', error.message);
        }
    } else {
        console.log('❌ .env.example not found');
    }
} else {
    console.log('✅ .env file already exists');
}

console.log('\n📋 Next steps:');
console.log('1. Edit .env file and add your Discord bot token');
console.log('2. Ensure your bot has the required permissions:');
console.log('   - Send Messages');
console.log('   - Use Slash Commands');
console.log('   - Connect (voice channels)');
console.log('   - Speak (voice channels)');
console.log('3. Run: npm start');
console.log('4. Join a voice channel and use /podcast commands');

console.log('\n🎵 Available commands:');
console.log('   /podcast play    - Play latest episode');
console.log('   /podcast random  - Play random episode');
console.log('   /podcast stop    - Stop playback');
console.log('   /podcast shownotes - Show episode info');

console.log('\n💡 Tip: The bot will auto-play random episodes when one finishes!');
