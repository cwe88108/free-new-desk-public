// Main-process bootstrap for V1.4.11.
// Playback session guards must load before feature IPC modules and before index.ts registers legacy handlers.
import './playback-session-ipc.js';
import './music-service.js';
import './fullscreen-overlay.js';
import './index.js';
