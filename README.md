# AlterEgo

A Manifest V3 Chrome Extension that uses AI (OpenAI-compatible protocol) to write and dynamically execute custom user scripts and styles on webpages via the `chrome.userScripts` API.

## Project Structure
- `manifest.json` - Extension manifest.
- `background.js` - Background Service Worker orchestrating LLM calls and user script registration.
- `popup/` - Popup UI files (HTML, CSS, JS).
- `content/` - Content scripts for capturing DOM context, element selection, and helper utilities.
- `lib/` - Helper scripts (if any).
