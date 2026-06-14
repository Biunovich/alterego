/**
 * AlterEgo Background Service Worker
 * Orchestrates side panel triggers, API calls to OpenAI-compatible endpoints,
 * and user scripts registration/storage persistence.
 */

import {
  SYSTEM_PROMPT_INITIAL,
  buildUserPromptInitial,
  SYSTEM_PROMPT_RETRY,
  buildUserPromptRetry
} from './prompts.js';

// 1. Configure Side Panel to open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[AlterEgo] Failed to set side panel behavior:', error));

// Guard: Verify if UserScripts API is enabled
function checkUserScriptsAvailable() {
  if (typeof chrome.userScripts === 'undefined') {
    throw new Error('Chrome UserScripts API is disabled. Please go to chrome://extensions/, click "Details" on the AlterEgo extension, and toggle "Allow User Scripts" to ON.');
  }
}

// Helper: Extract primary domain from a URL
function getDomain(url) {
  try {
    const parsed = new URL(url);
    // Return hostname (e.g. www.reddit.com) or fallback
    return parsed.hostname;
  } catch (e) {
    return null;
  }
}

// Helper: Compile wrapper user script that handles styled injection at start and JS execution at load
function compileUserScriptWrapper(css, js) {
  // Escape backticks and template literals safely
  const escapedCss = css ? css.replace(/`/g, '\\`').replace(/\${/g, '\\${') : '';
  
  return `(function() {
    // 1. Immediately inject custom styles to prevent layout flash (FOUC)
    const cssContent = \`${escapedCss}\`;
    if (cssContent) {
      const style = document.createElement('style');
      style.id = 'alterego-style-injected';
      style.textContent = cssContent;
      (document.head || document.documentElement).appendChild(style);
    }

    // 2. Wrap and run user-defined Javascript when DOM is ready
    function runJS() {
      try {
        console.log('[AlterEgo] Executing customized behavior...');
        ${js}
      } catch (err) {
        console.error('[AlterEgo] Runtime script error:', err);
        const event = new CustomEvent('alterego-script-error', {
          detail: {
            message: err.message,
            stack: err.stack ? err.stack.toString() : '',
            name: err.name || 'Error'
          }
        });
        window.dispatchEvent(event);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runJS);
    } else {
      runJS();
    }
  })();`;
}

// Helper: Register a script with the chrome.userScripts API
async function registerUserScript(domain, scriptId, css, js) {
  checkUserScriptsAvailable();
  const code = compileUserScriptWrapper(css, js);
  
  // Clean up any existing registration with same ID first
  try {
    const existing = await chrome.userScripts.getRegisteredUserScripts({ ids: [scriptId] });
    if (existing && existing.length > 0) {
      await chrome.userScripts.unregister({ ids: [scriptId] });
      // Short delay to allow unregistration to propagate in Chrome
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  } catch (e) {
    console.warn(`[AlterEgo] Error cleaning up script ${scriptId}:`, e);
  }

  // Register the new user script with retry on Duplicate error
  try {
    await chrome.userScripts.register([{
      id: scriptId,
      matches: [`*://*.${domain}/*`],
      js: [{ code: code }],
      runAt: 'document_start'
    }]);
  } catch (err) {
    if (err.message && err.message.includes('Duplicate script ID')) {
      console.warn(`[AlterEgo] Duplicate script ID '${scriptId}' detected. Retrying registration...`);
      try {
        await chrome.userScripts.unregister({ ids: [scriptId] });
        await new Promise(resolve => setTimeout(resolve, 150));
        await chrome.userScripts.register([{
          id: scriptId,
          matches: [`*://*.${domain}/*`],
          js: [{ code: code }],
          runAt: 'document_start'
        }]);
      } catch (retryErr) {
        console.error('[AlterEgo] Retry registration failed:', retryErr);
        throw new Error(`Duplicate script ID registration failed: ${retryErr.message}`);
      }
    } else {
      throw err;
    }
  }
  
  console.log(`[AlterEgo] Registered user script for ${domain} (${scriptId})`);
}

// Helper: Unregister a script
async function unregisterUserScript(scriptId) {
  try {
    checkUserScriptsAvailable();
    await chrome.userScripts.unregister({ ids: [scriptId] });
    console.log(`[AlterEgo] Unregistered script ${scriptId}`);
  } catch (e) {
    console.warn(`[AlterEgo] Script ${scriptId} was not registered or could not be unregistered:`, e);
  }
}

// 2. Re-register all active scripts on Service Worker startup
async function reinitializeScripts() {
  try {
    checkUserScriptsAvailable();
  } catch (e) {
    console.warn('[AlterEgo] Startup reinitialization skipped: UserScripts API is disabled.');
    return;
  }
  const { customizations = {} } = await chrome.storage.local.get('customizations');
  
  // Clear any active sessions in browser engine to start clean
  try {
    const active = await chrome.userScripts.getRegisteredUserScripts();
    if (active.length > 0) {
      const ids = active.map(s => s.id);
      await chrome.userScripts.unregister({ ids });
    }
  } catch (e) {
    console.error('[AlterEgo] Error clearing registered scripts on startup:', e);
  }

  // Register all enabled customizations
  for (const config of Object.values(customizations)) {
    if (config.enabled) {
      try {
        await registerUserScript(config.domain, config.id, config.css, config.js);
      } catch (err) {
        console.error(`[AlterEgo] Failed to register script for ${config.domain} on startup:`, err);
      }
    }
  }
}

// Run startup initialization
chrome.runtime.onStartup.addListener(reinitializeScripts);
chrome.runtime.onInstalled.addListener(reinitializeScripts);

// Automatically sync user scripts when configuration changes in storage
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local' && changes.customizations) {
    const oldValue = changes.customizations.oldValue || {};
    const newValue = changes.customizations.newValue || {};

    // Detect which script changed
    for (const [id, newConfig] of Object.entries(newValue)) {
      const oldConfig = oldValue[id];
      if (!oldConfig || JSON.stringify(oldConfig) !== JSON.stringify(newConfig)) {
        // Script was added, modified, or toggled
        if (newConfig.enabled) {
          try {
            await registerUserScript(newConfig.domain, newConfig.id, newConfig.css, newConfig.js);
          } catch (err) {
            console.error(`[AlterEgo] Failed to auto-reload changed script ${newConfig.id}:`, err);
          }
        } else {
          await unregisterUserScript(newConfig.id);
        }
      }
    }

    // Detect deleted/removed scripts
    for (const id of Object.keys(oldValue)) {
      if (!newValue[id]) {
        await unregisterUserScript(id);
      }
    }
  }
});

const runtimeErrors = {}; // key: tabId, value: Array of error objects

// Helper: send progress updates to the popup/side panel
async function sendProgress(tabId, message) {
  console.log(`[AlterEgo][Tab ${tabId}] Progress:`, message);
  try {
    await chrome.runtime.sendMessage({
      action: 'customization-progress',
      message
    });
  } catch (e) {
    // Popup might be closed or not listening, ignore
  }
}

// Helper: robust JSON parser that handles codeblock wrappers
function parseJSONResponse(rawText) {
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  }
  return JSON.parse(cleaned);
}

// 3. Handle incoming messages from Popup / Content Scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Capture script errors immediately
  if (request.action === 'report-script-error') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId) {
      if (!runtimeErrors[tabId]) {
        runtimeErrors[tabId] = [];
      }
      runtimeErrors[tabId].push(request.error);
      console.log(`[AlterEgo] Logged runtime error for tab ${tabId}:`, request.error);
    }
    sendResponse({ success: true });
    return true;
  }

  // Handle async response
  const handleMessage = async () => {
    try {
      if (request.action === 'generate-customization') {
        const { prompt, domain, context, targetSelector, id } = request;
        
        let tabId = request.tabId;
        if (!tabId) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab) {
            tabId = activeTab.id;
          }
        }
        if (!tabId) {
          throw new Error('No active tab found for customization.');
        }

        // Get API credentials and existing customizations from local storage
        const { apiKey, baseUrl, model, customizations = {} } = await chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'customizations']);

        if (!apiKey || !baseUrl || !model) {
          throw new Error('API Configuration is missing. Please save your API details in settings first.');
        }

        console.log(`[AlterEgo] Requesting AI customization for ${domain} (Refinement ID: ${id || 'New'})...`);

        const scriptId = id || `alterego-script-${Date.now()}`;
        const existing = id ? (customizations[id] || null) : null;

        let content = null;
        let attempt = 1;
        const maxAttempts = 3;
        let verificationFailureReason = "";
        let verified = false;

        // Clear errors before starting
        runtimeErrors[tabId] = [];

        while (attempt <= maxAttempts) {
          await sendProgress(tabId, `Attempt ${attempt}/${maxAttempts}: Querying AI model...`);

          let systemPrompt = "";
          let userPrompt = "";

          if (attempt === 1) {
            systemPrompt = SYSTEM_PROMPT_INITIAL;
            userPrompt = buildUserPromptInitial(domain, targetSelector, prompt, existing, context);
          } else {
            systemPrompt = SYSTEM_PROMPT_RETRY;
            userPrompt = buildUserPromptRetry(domain, prompt, content.css, content.js, verificationFailureReason, context);
          }

          // Request completions from OpenAI-compatible endpoint
          const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ],
              response_format: { type: 'json_object' },
              temperature: 0.2
            })
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`AI API error (${response.status}): ${errText}`);
          }

          const data = await response.json();
          const rawResponseText = data.choices[0].message.content.trim();
          try {
            content = parseJSONResponse(rawResponseText);
          } catch (e) {
            console.error('[AlterEgo] Failed to parse JSON response:', rawResponseText);
            throw new Error(`AI returned invalid JSON: ${e.message}`);
          }

          // Register script immediately
          await sendProgress(tabId, `Attempt ${attempt}/${maxAttempts}: Code generated. Injecting and reloading tab...`);
          await registerUserScript(domain, scriptId, content.css, content.js);

          // Clear errors on tab before reload to ensure we only capture errors from this run
          runtimeErrors[tabId] = [];

          // Reload tab
          await chrome.tabs.reload(tabId);

          // Wait 1.5 seconds for execution
          await new Promise(resolve => setTimeout(resolve, 1500));

          // Verify status
          const errors = runtimeErrors[tabId] || [];
          let domVerified = true;
          let domErrorMsg = "";

          if (content.verificationSelector) {
            try {
              // Ensure extractor is running on reload
              await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content/context-extractor.js']
              });
              const verifyRes = await chrome.tabs.sendMessage(tabId, { action: 'verify-dom', selector: content.verificationSelector });
              domVerified = verifyRes ? !!verifyRes.exists : false;
              if (!domVerified) {
                domErrorMsg = `Selector '${content.verificationSelector}' was not found in the page DOM.`;
              }
            } catch (err) {
              domVerified = false;
              domErrorMsg = `Could not verify DOM: ${err.message}`;
            }
          }

          if (errors.length > 0) {
            const errList = errors.map(e => `${e.name || 'Error'}: ${e.message}`).join('\n');
            verificationFailureReason = `The JavaScript code threw runtime exception(s):\n${errList}`;
            if (domErrorMsg) {
              verificationFailureReason += `\n\nAdditionally: ${domErrorMsg}`;
            }
            await sendProgress(tabId, `⚠️ Attempt ${attempt} failed with JS runtime error. Self-healing...`);
            attempt++;
          } else if (!domVerified) {
            verificationFailureReason = `DOM Verification Failed:\n${domErrorMsg}`;
            await sendProgress(tabId, `⚠️ Attempt ${attempt} failed: verification selector not found. Self-healing...`);
            attempt++;
          } else {
            verified = true;
            await sendProgress(tabId, `✓ Customization verified successfully!`);
            break;
          }
        }

        if (!verified) {
          throw new Error(`Self-healing failed after ${maxAttempts} attempts.\nLast failure: ${verificationFailureReason}`);
        }

        // Store customization in local storage
        customizations[scriptId] = {
          id: scriptId,
          domain,
          prompt,
          css: content.css,
          js: content.js,
          enabled: true,
          verificationSelector: content.verificationSelector || '',
          description: content.description || 'Custom layout and behaviors.'
        };
        await chrome.storage.local.set({ customizations });

        sendResponse({ success: true, description: content.description });

      } else if (request.action === 'toggle-customization') {
        const { id, enabled } = request;
        const { customizations = {} } = await chrome.storage.local.get('customizations');

        if (customizations[id]) {
          customizations[id].enabled = enabled;
          await chrome.storage.local.set({ customizations });

          if (enabled) {
            await registerUserScript(customizations[id].domain, customizations[id].id, customizations[id].css, customizations[id].js);
          } else {
            await unregisterUserScript(customizations[id].id);
          }
          sendResponse({ success: true });
        } else {
          throw new Error('Customization not found.');
        }

      } else if (request.action === 'delete-customization') {
        const { id, domain } = request;
        const { customizations = {} } = await chrome.storage.local.get('customizations');

        if (id) {
          if (customizations[id]) {
            await unregisterUserScript(customizations[id].id);
            delete customizations[id];
            await chrome.storage.local.set({ customizations });
            sendResponse({ success: true });
          } else {
            throw new Error('Customization not found.');
          }
        } else if (domain) {
          // Reset: Delete all customizations matching this domain
          const idsToDelete = [];
          for (const [key, config] of Object.entries(customizations)) {
            if (config.domain === domain) {
              idsToDelete.push(key);
            }
          }
          for (const key of idsToDelete) {
            await unregisterUserScript(customizations[key].id);
            delete customizations[key];
          }
          await chrome.storage.local.set({ customizations });
          sendResponse({ success: true });
        }
      }
    } catch (err) {
      console.error('[AlterEgo] Error in message handler:', err);
      sendResponse({ success: false, error: err.message });
    }
  };

  handleMessage();
  return true; // Keep response channel open for async completions
});
