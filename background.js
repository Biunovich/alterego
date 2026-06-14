/**
 * AlterEgo Background Service Worker
 * Orchestrates side panel triggers, API calls to OpenAI-compatible endpoints,
 * and user scripts registration/storage persistence.
 */

import {
  SYSTEM_PROMPT_INITIAL,
  buildUserPromptInitial,
  SYSTEM_PROMPT_RETRY,
  buildUserPromptRetry,
  buildRefinementUserPrompt
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
function compileUserScriptWrapper(css, js, apiToken) {
  // Escape backticks and template literals safely
  const escapedCss = css ? css.replace(/`/g, '\\`').replace(/\${/g, '\\${') : '';
  
  return `(function() {
    const ALTEREGO_API_TOKEN = "${apiToken || ''}";

    // Helper function to call the background AI model
    function askAlterEgoAI(promptText) {
      return new Promise((resolve, reject) => {
        const requestId = Math.random().toString(36).substring(2, 9);
        const handler = (e) => {
          window.removeEventListener('alterego-api-response-' + requestId, handler);
          if (e.detail.success) {
            resolve(e.detail.result);
          } else {
            reject(new Error(e.detail.error));
          }
        };
        window.addEventListener('alterego-api-response-' + requestId, handler);
        window.dispatchEvent(new CustomEvent('alterego-api-request', {
          detail: { requestId, action: 'ai-completion', token: ALTEREGO_API_TOKEN, payload: { prompt: promptText } }
        }));
      });
    }

    // Expose globally in user script world
    window.askAlterEgoAI = askAlterEgoAI;

    // Helper function to wait for dynamic elements in SPA pages
    function waitForElements(selector, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const el = document.querySelectorAll(selector);
        if (el && el.length > 0) {
          return resolve(Array.from(el));
        }

        const observer = new MutationObserver(() => {
          const elements = document.querySelectorAll(selector);
          if (elements && elements.length > 0) {
            observer.disconnect();
            clearTimeout(timeoutId);
            resolve(Array.from(elements));
          }
        });

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true
        });

        const timeoutId = setTimeout(() => {
          observer.disconnect();
          reject(new Error('Timeout waiting for selector: ' + selector));
        }, timeout);
      });
    }

    // Expose globally in user script world
    window.waitForElements = waitForElements;

    // 1. Immediately inject custom styles to prevent layout flash (FOUC)
    const cssContent = \`${escapedCss}\`;
    if (cssContent) {
      const style = document.createElement('style');
      style.id = 'alterego-style-injected';
      style.textContent = cssContent;
      (document.head || document.documentElement).appendChild(style);
    }

    // Capture global unhandled exceptions in this script context
    window.addEventListener('error', function(errEvent) {
      console.error('[AlterEgo] Unhandled script exception:', errEvent.error);
      const event = new CustomEvent('alterego-script-status', {
        detail: {
          status: 'error',
          error: {
            message: errEvent.message || 'Unhandled error',
            stack: errEvent.error && errEvent.error.stack ? errEvent.error.stack.toString() : '',
            name: errEvent.error && errEvent.error.name ? errEvent.error.name : 'UnhandledException'
          }
        }
      });
      window.dispatchEvent(event);
    });

    window.addEventListener('unhandledrejection', function(promiseEvent) {
      console.error('[AlterEgo] Unhandled promise rejection:', promiseEvent.reason);
      const reason = promiseEvent.reason || {};
      const event = new CustomEvent('alterego-script-status', {
        detail: {
          status: 'error',
          error: {
            message: reason.message || 'Unhandled promise rejection',
            stack: reason.stack ? reason.stack.toString() : '',
            name: reason.name || 'PromiseRejection'
          }
        }
      });
      window.dispatchEvent(event);
    });

    // 2. Wrap and run user-defined Javascript when DOM is ready
    function runJS() {
      try {
        console.log('[AlterEgo] Executing customized behavior...');
        ${js}
        // Success signal (if synchronous run finishes without error)
        window.dispatchEvent(new CustomEvent('alterego-script-status', {
          detail: { status: 'success' }
        }));
      } catch (err) {
        console.error('[AlterEgo] Runtime script error:', err);
        window.dispatchEvent(new CustomEvent('alterego-script-status', {
          detail: {
            status: 'error',
            error: {
              message: err.message,
              stack: err.stack ? err.stack.toString() : '',
              name: err.name || 'Error'
            }
          }
        }));
      }
    }

    // SPA virtual navigation observer
    let lastUrl = location.href;
    const urlObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log('[AlterEgo] SPA Navigation detected, re-applying script...');
        if (cssContent && !document.getElementById('alterego-style-injected')) {
          const style = document.createElement('style');
          style.id = 'alterego-style-injected';
          style.textContent = cssContent;
          (document.head || document.documentElement).appendChild(style);
        }
        runJS();
      }
    });
    urlObserver.observe(document.documentElement, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runJS);
    } else {
      runJS();
    }
  })();`;
}

// Helper: Generate a unique API capability token per session/customization
function generateApiToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Helper: Prune user prompt content by removing large context blocks to save storage
function pruneUserMessageContent(content) {
  if (typeof content !== 'string') return content;
  let pruned = content;
  pruned = pruned.replace(/Targeted Element Context \(Focused DOM around chosen element\):\s*```[\s\S]*?```/g, '[Targeted Element Context Pruned]');
  pruned = pruned.replace(/Simplified Webpage DOM Context:\s*```[\s\S]*?```/g, '[Simplified Webpage DOM Context Pruned]');
  return pruned;
}

// Helper: Prune history messages and limit history size to 5 turns (10 messages)
function pruneHistory(history) {
  if (!Array.isArray(history)) return [];
  let prunedHistory = history.map(item => {
    if (item.role === 'user') {
      return {
        ...item,
        content: pruneUserMessageContent(item.content)
      };
    }
    return item;
  });
  if (prunedHistory.length > 10) {
    prunedHistory = prunedHistory.slice(-10);
  }
  return prunedHistory;
}

// Helper: Register a script with the chrome.userScripts API
async function registerUserScript(domain, scriptId, css, js, apiToken) {
  checkUserScriptsAvailable();
  const code = compileUserScriptWrapper(css, js, apiToken);
  
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

  let storageUpdated = false;
  // Register all enabled customizations
  for (const config of Object.values(customizations)) {
    if (!config.apiToken) {
      config.apiToken = generateApiToken();
      storageUpdated = true;
    }
    if (config.enabled) {
      try {
        await registerUserScript(config.domain, config.id, config.css, config.js, config.apiToken);
      } catch (err) {
        console.error(`[AlterEgo] Failed to register script for ${config.domain} on startup:`, err);
      }
    }
  }

  if (storageUpdated) {
    await chrome.storage.local.set({ customizations });
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
            await registerUserScript(newConfig.domain, newConfig.id, newConfig.css, newConfig.js, newConfig.apiToken);
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

// Storage Session helpers for tab runtime errors (MV3 state safety)
async function getTabErrors(tabId) {
  try {
    const { tabErrors = {} } = await chrome.storage.session.get('tabErrors');
    return tabErrors[tabId] || [];
  } catch (e) {
    return [];
  }
}

async function clearTabErrors(tabId) {
  try {
    const { tabErrors = {} } = await chrome.storage.session.get('tabErrors');
    delete tabErrors[tabId];
    await chrome.storage.session.set({ tabErrors });
  } catch (e) {
    console.error('[AlterEgo] Failed to clear tab errors:', e);
  }
}

async function addTabError(tabId, error) {
  try {
    const { tabErrors = {} } = await chrome.storage.session.get('tabErrors');
    if (!tabErrors[tabId]) {
      tabErrors[tabId] = [];
    }
    tabErrors[tabId].push(error);
    await chrome.storage.session.set({ tabErrors });
  } catch (e) {
    console.error('[AlterEgo] Failed to add tab error:', e);
  }
}

const activeGenerations = {}; // key: tabId, value: { controller, cancelled: false }

// Helper: send progress updates to the popup/side panel
function sendProgress(tabId, message) {
  console.log(`[AlterEgo][Tab ${tabId}] Progress:`, message);
  chrome.runtime.sendMessage({
    action: 'customization-progress',
    message
  }).catch(() => {
    // Popup might be closed or not listening, ignore
  });
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
  // Capture script status immediately (success or error)
  if (request.action === 'report-script-status') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId) {
      (async () => {
        if (request.status === 'error' && request.error) {
          await addTabError(tabId, request.error);
          console.log(`[AlterEgo] Logged runtime error for tab ${tabId}:`, request.error);
        } else {
          console.log(`[AlterEgo] Logged success status for tab ${tabId}`);
        }
        sendResponse({ success: true });
      })();
    } else {
      sendResponse({ success: true });
    }
    return true;
  }

  if (request.action === 'cancel-generation') {
    const { tabId } = request;
    if (tabId && activeGenerations[tabId]) {
      activeGenerations[tabId].cancelled = true;
      activeGenerations[tabId].controller.abort();
      delete activeGenerations[tabId];
      console.log(`[AlterEgo] Cancelled generation for tab ${tabId}`);
    }
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'alterego-api-request-relay') {
    const { apiAction, token, payload } = request;
    if (apiAction === 'ai-completion') {
      (async () => {
        try {
          const senderUrl = sender.tab ? sender.tab.url : (sender.url || '');
          const domain = getDomain(senderUrl);
          if (!domain) {
            sendResponse({ success: false, error: 'Unauthorized: Unable to verify sender domain.' });
            return;
          }

          const { apiKey, baseUrl, model, customizations = {} } = await chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'customizations']);
          if (!apiKey || !baseUrl || !model) {
            sendResponse({ success: false, error: 'API configuration is missing. Please save settings in side panel.' });
            return;
          }

          // Find enabled customizations for this domain
          const domainCustomizations = Object.values(customizations).filter(c => c.domain === domain && c.enabled);
          
          // Check if token matches
          const isValidToken = domainCustomizations.some(c => c.apiToken && c.apiToken === token);
          if (!isValidToken) {
            sendResponse({ success: false, error: 'Unauthorized: Invalid or missing API capability token.' });
            return;
          }

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
                { role: 'user', content: payload.prompt }
              ],
              temperature: payload.temperature ?? 0.2
            })
          });

          if (!response.ok) {
            const errText = await response.text();
            sendResponse({ success: false, error: `AI API error (${response.status}): ${errText}` });
            return;
          }

          const data = await response.json();
          const resultText = data.choices[0].message.content;
          sendResponse({ success: true, result: resultText });
        } catch (err) {
          console.error('[AlterEgo] Error in relayed API request:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
    } else {
      sendResponse({ success: false, error: `Unsupported API action: ${apiAction}` });
    }
    return true; // Keep message channel open
  }

  // Handle async response
  const handleMessage = async () => {
    try {
      if (request.action === 'generate-customization') {
        const { prompt, domain, context, targetedContext, targetSelector, id } = request;
        
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
        const apiToken = (existing && existing.apiToken) || generateApiToken();

        // Retrieve or initialize the conversation history
        let conversationHistory = [];
        if (existing) {
          if (existing.history && Array.isArray(existing.history)) {
            conversationHistory = [...existing.history];
          } else {
            // Seed history from existing customization
            const seedUserPrompt = buildUserPromptInitial(
              domain,
              targetSelector,
              existing.prompt || prompt,
              null,
              context,
              targetedContext
            );
            const seedAssistantPrompt = JSON.stringify({
              css: existing.css,
              js: existing.js,
              verificationSelector: existing.verificationSelector || '',
              description: existing.description || ''
            });
            conversationHistory = [
              { role: 'user', content: seedUserPrompt },
              { role: 'assistant', content: seedAssistantPrompt }
            ];
          }
        }

        let sessionMessages = [];
        if (existing) {
          sessionMessages = [
            ...conversationHistory,
            { role: 'user', content: buildRefinementUserPrompt(prompt) }
          ];
        } else {
          sessionMessages = [
            { role: 'user', content: buildUserPromptInitial(domain, targetSelector, prompt, null, context, targetedContext) }
          ];
        }

        let content = null;
        let attempt = 1;
        const maxAttempts = 3;
        let verificationFailureReason = "";
        let verified = false;

        const controller = new AbortController();
        activeGenerations[tabId] = { controller, cancelled: false };

        // Clear errors before starting
        await clearTabErrors(tabId);

        try {
          while (attempt <= maxAttempts) {
            if (activeGenerations[tabId]?.cancelled) {
              throw new Error('Generation cancelled by user.');
            }

            await sendProgress(tabId, `Attempt ${attempt}/${maxAttempts}: Querying AI model...`);

            let systemPrompt = (attempt === 1) ? SYSTEM_PROMPT_INITIAL : SYSTEM_PROMPT_RETRY;
            
            let apiMessages = [
              { role: 'system', content: systemPrompt },
              ...sessionMessages
            ];

            // Request completions from OpenAI-compatible endpoint
            const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
            const response = await fetch(endpoint, {
              method: 'POST',
              signal: controller.signal,
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              },
              body: JSON.stringify({
                model: model,
                messages: apiMessages,
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

            if (activeGenerations[tabId]?.cancelled) {
              throw new Error('Generation cancelled by user.');
            }

            // Register script immediately
            await sendProgress(tabId, `Attempt ${attempt}/${maxAttempts}: Code generated. Injecting and reloading tab...`);
            await registerUserScript(domain, scriptId, content.css, content.js, apiToken);

            // Clear errors on tab before reload to ensure we only capture errors from this run
            await clearTabErrors(tabId);

            // Set up verifier (wait for reload complete)
            let resolveReload;
            const reloadPromise = new Promise((resolve) => {
              resolveReload = resolve;
            });

            const checkTabListener = (updatedTabId, changeInfo) => {
              if (updatedTabId === tabId && changeInfo.status === 'complete') {
                resolveReload();
              }
            };

            chrome.tabs.onUpdated.addListener(checkTabListener);

            const timeoutId = setTimeout(() => {
              resolveReload();
            }, 7000);

            // Reload tab
            await chrome.tabs.reload(tabId);

            // Wait for reload to complete
            await reloadPromise;

            // Cleanup
            chrome.tabs.onUpdated.removeListener(checkTabListener);
            clearTimeout(timeoutId);

            console.log(`[AlterEgo] Tab reload completed or timed out for tab ${tabId}`);

            // Give the scripts a small grace period to execute their callbacks (e.g. 400ms)
            await new Promise(resolve => setTimeout(resolve, 400));

            if (activeGenerations[tabId]?.cancelled) {
              throw new Error('Generation cancelled by user.');
            }

            // Verify status
            const errors = await getTabErrors(tabId);
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
                if (verifyRes && verifyRes.exists) {
                  if (verifyRes.isLogicalFailure) {
                    domVerified = false;
                    domErrorMsg = `Logical check failed: ${verifyRes.failureReason}`;
                  } else {
                    domVerified = true;
                  }
                } else {
                  domVerified = false;
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
              
              // Append retry context to sessionMessages for the next turn
              sessionMessages.push({
                role: 'assistant',
                content: rawResponseText
              });
              sessionMessages.push({
                role: 'user',
                content: buildUserPromptRetry(domain, prompt, content.css, content.js, verificationFailureReason, context)
              });
              attempt++;
            } else if (!domVerified) {
              verificationFailureReason = `DOM Verification Failed:\n${domErrorMsg}`;
              await sendProgress(tabId, `⚠️ Attempt ${attempt} failed: verification selector not found. Self-healing...`);
              
              // Append retry context to sessionMessages for the next turn
              sessionMessages.push({
                role: 'assistant',
                content: rawResponseText
              });
              sessionMessages.push({
                role: 'user',
                content: buildUserPromptRetry(domain, prompt, content.css, content.js, verificationFailureReason, context)
              });
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

          // Construct the updated conversation history
          const finalHistory = [
            ...conversationHistory,
            { role: 'user', content: existing ? buildRefinementUserPrompt(prompt) : buildUserPromptInitial(domain, targetSelector, prompt, null, context, targetedContext) },
            { role: 'assistant', content: JSON.stringify({
                css: content.css,
                js: content.js,
                verificationSelector: content.verificationSelector || '',
                description: content.description || ''
              }) 
            }
          ];

          // Store customization in local storage
          customizations[scriptId] = {
            id: scriptId,
            domain,
            prompt,
            css: content.css,
            js: content.js,
            enabled: true,
            verificationSelector: content.verificationSelector || '',
            description: content.description || 'Custom layout and behaviors.',
            apiToken: apiToken,
            history: pruneHistory(finalHistory)
          };
          await chrome.storage.local.set({ customizations });

          sendResponse({ success: true, description: content.description });
        } finally {
          delete activeGenerations[tabId];
        }

      } else if (request.action === 'toggle-customization') {
        const { id, enabled } = request;
        const { customizations = {} } = await chrome.storage.local.get('customizations');

        if (customizations[id]) {
          customizations[id].enabled = enabled;
          await chrome.storage.local.set({ customizations });

          if (enabled) {
            await registerUserScript(customizations[id].domain, customizations[id].id, customizations[id].css, customizations[id].js, customizations[id].apiToken);
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

  const asyncActions = ['generate-customization', 'toggle-customization', 'delete-customization'];
  if (asyncActions.includes(request.action)) {
    handleMessage();
    return true;
  }
});
