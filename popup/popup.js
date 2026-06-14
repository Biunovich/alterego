/**
 * AlterEgo Side Panel Controller
 * Handles UI interactions, API configuration management, active tab script injection,
 * interactive element picker coordination, and customizations lists.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // UI Element bindings
  const apiKeyInput = document.getElementById('api-key');
  const apiProviderSelect = document.getElementById('api-provider');
  const baseUrlInput = document.getElementById('base-url');
  const baseUrlGroup = document.getElementById('base-url-group');
  const modelNameInput = document.getElementById('model-name');

  const WELL_KNOWN_PROVIDERS = ['openai', 'deepseek', 'openrouter', 'groq', 'gemini'];

  function updateBaseUrlVisibility(provider) {
    if (WELL_KNOWN_PROVIDERS.includes(provider)) {
      baseUrlGroup.style.display = 'none';
    } else {
      baseUrlGroup.style.display = 'flex';
    }
  }
  const settingsPanel = document.getElementById('settings-panel');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const btnSettingsToggle = document.getElementById('settings-toggle');

  const promptInput = document.getElementById('prompt-input');
  const btnPicker = document.getElementById('btn-picker');
  const btnAlter = document.getElementById('btn-alter');
  const pickerIndicator = document.getElementById('picker-indicator');
  const pickerSelectorText = document.getElementById('picker-selector-text');

  const statusText = document.getElementById('status-text');
  const statusBadge = document.getElementById('status-badge');
  const loaderOverlay = document.getElementById('loader-overlay');
  const loaderText = document.getElementById('loader-text');

  const customizationList = document.getElementById('customization-list');
  const btnResetPage = document.getElementById('btn-reset-page');

  // Hardcoded Base URLs for popular API providers
  const PROVIDER_URLS = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai'
  };

  // Active state variables
  let currentTab = null;
  let currentDomain = null;
  let selectedSelector = null;
  let isPickingMode = false;
  let activeRefineId = null; // Track which customization script is being refined

  // 1. Initialize API and Tab details
  await loadSettings();
  await refreshActiveTabContext();
  await renderCustomizations();

  // 2. Load connection configurations from chrome.storage.local
  async function loadSettings() {
    const { apiKey = '', baseUrl = 'https://api.openai.com/v1', model = '' } = 
      await chrome.storage.local.get(['apiKey', 'baseUrl', 'model']);

    apiKeyInput.value = apiKey;
    baseUrlInput.value = baseUrl;

    // Detect and select matching provider dropdown option
    let matchedProvider = 'custom';
    for (const [key, url] of Object.entries(PROVIDER_URLS)) {
      if (baseUrl.replace(/\/$/, '') === url.replace(/\/$/, '')) {
        matchedProvider = key;
        break;
      }
    }
    apiProviderSelect.value = matchedProvider;
    updateBaseUrlVisibility(matchedProvider);
    
    // Ensure the saved model option is dynamically added to the list
    if (model) {
      modelNameInput.innerHTML = ''; // Clear the "Fetch models..." placeholder
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = model;
      modelNameInput.appendChild(opt);
      modelNameInput.value = model;
    }

    // Auto expand configuration if API key is missing
    if (!apiKey) {
      settingsPanel.style.display = 'flex';
      btnSettingsToggle.textContent = '▲';
    }
  }

  const btnFetchModels = document.getElementById('btn-fetch-models');

  // Reusable helper to fetch models from server
  async function performModelFetch(isManual = false) {
    const apiKey = apiKeyInput.value.trim();
    const baseUrl = baseUrlInput.value.trim();

    if (!apiKey || !baseUrl) {
      if (isManual) {
        alert('Please enter an API Key and Base URL first.');
      }
      return;
    }

    btnFetchModels.textContent = '...';
    btnFetchModels.disabled = true;

    try {
      const endpoint = `${baseUrl.replace(/\/$/, '')}/models`;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data && data.data && Array.isArray(data.data)) {
        const currentSelected = modelNameInput.value;
        modelNameInput.innerHTML = '';

        // Sort model names alphabetically
        const models = data.data.map(m => m.id).sort();

        models.forEach(modelId => {
          const opt = document.createElement('option');
          opt.value = modelId;
          opt.textContent = modelId;
          modelNameInput.appendChild(opt);
        });

        // Re-select previously saved model if it's in the list
        const optionExists = Array.from(modelNameInput.options).some(opt => opt.value === currentSelected);
        if (optionExists) {
          modelNameInput.value = currentSelected;
        } else if (modelNameInput.options.length > 0) {
          modelNameInput.selectedIndex = 0;
        }

        showStatus('Models Loaded', '#2ed573');
      } else {
        throw new Error('Invalid models API response structure');
      }
    } catch (err) {
      console.error('[AlterEgo] Failed to fetch models:', err);
      if (isManual) {
        alert(`Failed to fetch models: ${err.message}. Please check your credentials.`);
      }
      showStatus('Fetch Failed', '#ff4757');
    } finally {
      btnFetchModels.textContent = 'Fetch';
      btnFetchModels.disabled = false;
    }
  }

  // Handle provider selection dropdown change to auto-fill Base URL and reset/auto-fetch models
  apiProviderSelect.addEventListener('change', () => {
    const provider = apiProviderSelect.value;
    if (provider !== 'custom' && PROVIDER_URLS[provider]) {
      baseUrlInput.value = PROVIDER_URLS[provider];
    } else if (provider === 'custom') {
      baseUrlInput.value = 'http://localhost:11434/v1';
    }
    // Reset model selection when the provider is changed to prevent loading invalid models
    modelNameInput.innerHTML = '<option value="" disabled selected>Fetch models...</option>';
    updateBaseUrlVisibility(provider);

    // Auto-fetch models if API key is entered
    if (apiKeyInput.value.trim()) {
      performModelFetch(false);
    }
  });

  // Auto-fetch models when configuration fields change in UI
  apiKeyInput.addEventListener('change', () => {
    performModelFetch(false);
  });

  baseUrlInput.addEventListener('change', () => {
    performModelFetch(false);
  });

  // Fetch Models Button Click (Manual overrides)
  btnFetchModels.addEventListener('click', () => {
    performModelFetch(true);
  });

  // Toggle settings visibility
  btnSettingsToggle.addEventListener('click', () => {
    const isVisible = settingsPanel.style.display === 'flex';
    settingsPanel.style.display = isVisible ? 'none' : 'flex';
    btnSettingsToggle.textContent = isVisible ? '⚙️' : '▲';
  });

  // Save Settings Click
  btnSaveSettings.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const baseUrl = baseUrlInput.value.trim();
    const model = modelNameInput.value;

    if (!apiKey) {
      showStatus('API Key Required', '#ff4757');
      return;
    }

    await chrome.storage.local.set({ apiKey, baseUrl, model });
    showStatus('Settings Saved', '#2ed573');
    
    // Smooth collapse after saving
    setTimeout(() => {
      settingsPanel.style.display = 'none';
      btnSettingsToggle.textContent = '⚙️';
    }, 800);
  });

  // Helper to show momentary status
  function showStatus(text, color = '#2ed573') {
    statusText.textContent = text;
    statusBadge.style.color = color;
    statusBadge.style.borderColor = color.replace(')', ', 0.35)').replace('#', 'rgba('); // simple alpha fallback
  }

  // 3. Detect and bind current tab info
  async function refreshActiveTabContext() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) {
        currentDomain = null;
        showStatus('Offline Tab', '#a4b0be');
        return;
      }

      currentTab = tab;
      
      // Exclude system pages
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://')) {
        currentDomain = null;
        showStatus('Restricted Page', '#ff4757');
        btnPicker.disabled = true;
        btnAlter.disabled = true;
        return;
      }

      const parsedUrl = new URL(tab.url);
      currentDomain = parsedUrl.hostname;
      showStatus('Ready');
      btnPicker.disabled = false;
      btnAlter.disabled = false;

      // Clear active refinement when switching pages to prevent cross-site corruption
      activeRefineId = null;
      updatePromptUIState(null);
    } catch (e) {
      console.error('[AlterEgo] Error reading tab context:', e);
      showStatus('Ready');
    }
  }

  // Update prompt UI elements depending on active refinement target
  function updatePromptUIState(refinementConfig) {
    const iterationStatus = document.getElementById('iteration-status');
    const iterationStatusText = document.getElementById('iteration-status-text');
    const btnAlter = document.getElementById('btn-alter');
    
    if (refinementConfig) {
      iterationStatusText.textContent = `🔄 Refining: "${refinementConfig.prompt}"`;
      iterationStatus.style.display = 'flex';
      btnAlter.textContent = 'Refine Script';
    } else {
      iterationStatus.style.display = 'none';
      btnAlter.textContent = 'Alter Page';
    }
  }

  // Cancel refinement button click
  const btnCancelRefine = document.getElementById('btn-cancel-refine');
  btnCancelRefine.addEventListener('click', () => {
    activeRefineId = null;
    updatePromptUIState(null);
    promptInput.placeholder = "e.g. Hide the sidebar, make links purple...";
  });

  // Monitor active tab shifts
  chrome.tabs.onActivated.addListener(async () => {
    await refreshActiveTabContext();
    await renderCustomizations();
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.status === 'complete') {
      await refreshActiveTabContext();
      await renderCustomizations();
    }
  });

  // 4. Interactive Target Picker Logic
  btnPicker.addEventListener('click', async () => {
    if (!currentTab) return;

    if (isPickingMode) {
      // Toggle OFF
      await stopPickingSession();
    } else {
      // Toggle ON
      await startPickingSession();
    }
  });

  async function startPickingSession() {
    isPickingMode = true;
    btnPicker.classList.add('active');
    btnPicker.innerHTML = '⚡ Selecting...';
    showStatus('Select Element', '#ff9f43');

    try {
      // 1. Inject content script dynamically to ensure it runs
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        files: ['content/context-extractor.js']
      });

      // 2. Dispatch pick start instruction
      await chrome.tabs.sendMessage(currentTab.id, { action: 'start-picking' });
    } catch (err) {
      console.error('[AlterEgo] Failed to start picking session:', err);
      showStatus('Picker Failed', '#ff4757');
      btnPicker.classList.remove('active');
      btnPicker.innerHTML = '🎯 Pick Target';
      isPickingMode = false;
    }
  }

  async function stopPickingSession() {
    isPickingMode = false;
    btnPicker.classList.remove('active');
    btnPicker.innerHTML = '🎯 Pick Target';
    showStatus('Ready');

    try {
      await chrome.tabs.sendMessage(currentTab.id, { action: 'stop-picking' });
    } catch (e) {
      // Safe to ignore if tab is gone
    }
  }

  // Listen for Selection Return from Content Script and progress updates
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'element-picked') {
      selectedSelector = message.selector;
      
      // Update UI elements
      pickerSelectorText.textContent = `${message.tagName}${selectedSelector}`;
      pickerIndicator.classList.add('active');
      
      isPickingMode = false;
      btnPicker.classList.remove('active');
      btnPicker.innerHTML = '🎯 Pick Target';
      showStatus('Element Bound', '#2ed573');
      sendResponse({ status: 'selector_received' });
    } else if (message.action === 'customization-progress') {
      loaderText.textContent = message.message;
      sendResponse({ status: 'progress_received' });
    }
    return true;
  });

  // 5. Submit Alter Request
  btnAlter.addEventListener('click', async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      showStatus('Prompt Required', '#ff4757');
      return;
    }

    // Verify key exists
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) {
      settingsPanel.style.display = 'flex';
      btnSettingsToggle.textContent = '▲';
      showStatus('API Key Required', '#ff4757');
      return;
    }

    if (!currentTab || !currentDomain) {
      showStatus('Invalid Tab', '#ff4757');
      return;
    }

    // Trigger loader
    loaderText.textContent = 'Scanning webpage structure...';
    loaderOverlay.classList.add('active');
    btnAlter.disabled = true;

    try {
      // 1. Inject context script
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        files: ['content/context-extractor.js']
      });

      // 2. Fetch DOM context
      const contextResponse = await chrome.tabs.sendMessage(currentTab.id, { action: 'get-context' });
      
      loaderText.textContent = 'AI is writing your customized scripts...';

      // 3. Message service worker to compile with LLM and verify
      chrome.runtime.sendMessage({
        action: 'generate-customization',
        prompt: prompt,
        domain: currentDomain,
        context: contextResponse.context,
        targetSelector: selectedSelector,
        id: activeRefineId,
        tabId: currentTab.id
      }, async (response) => {
        loaderOverlay.classList.remove('active');
        btnAlter.disabled = false;

        if (response && response.success) {
          showStatus('Alteration Applied!', '#2ed573');
          promptInput.value = '';
          promptInput.placeholder = "e.g. Hide the sidebar, make links purple...";
          selectedSelector = null;
          pickerIndicator.classList.remove('active');
          activeRefineId = null;
          updatePromptUIState(null);
          
          // Refresh customizations list (tab is already reloaded and showing verified scripts)
          await renderCustomizations();
        } else {
          showStatus('Generation Failed', '#ff4757');
          alert(`Failed to customize: ${response ? response.error : 'Unknown API response error.'}`);
        }
      });

    } catch (err) {
      console.error('[AlterEgo] Customization request failed:', err);
      loaderOverlay.classList.remove('active');
      btnAlter.disabled = false;
      showStatus('Generation Failed', '#ff4757');
    }
  });

  // 6. Customization List Renderer
  async function renderCustomizations() {
    const { customizations = {} } = await chrome.storage.local.get('customizations');
    customizationList.innerHTML = '';

    const entries = Object.entries(customizations);

    if (entries.length === 0) {
      customizationList.innerHTML = '<div class="empty-state">No adjustments registered yet.</div>';
      btnResetPage.style.display = 'none';
      return;
    }

    // Ensure reset button is visible if there are active adjustments
    btnResetPage.style.display = 'block';

    // Prioritize current domain customizations by sorting
    entries.sort((a, b) => {
      const domainA = a[1].domain;
      const domainB = b[1].domain;
      if (domainA === currentDomain) return -1;
      if (domainB === currentDomain) return 1;
      return domainA.localeCompare(domainB);
    });

    entries.forEach(([id, config]) => {
      const isCurrent = (config.domain === currentDomain);
      
      const item = document.createElement('div');
      item.className = 'customization-item';
      if (isCurrent) {
        item.style.borderColor = 'rgba(255, 159, 67, 0.3)';
        item.style.background = 'rgba(255, 159, 67, 0.02)';
      }

      item.innerHTML = `
        <div class="customization-info">
          <div class="customization-domain" style="display: flex; align-items: center; gap: 6px;">
            ${config.domain} ${isCurrent ? '<span style="color:#ff9f43; font-size:10px; font-weight:bold;">(ACTIVE)</span>' : ''}
          </div>
          <div class="customization-desc" style="font-weight: 500; color: var(--text-main); margin: 3px 0;">"${config.prompt}"</div>
          <div class="customization-desc" style="font-size: 11px; color: var(--text-muted);">${config.description}</div>
        </div>
        <div class="customization-actions">
          <button class="btn-refine-script" data-id="${config.id}" data-prompt="${config.prompt.replace(/"/g, '&quot;')}" title="Refine this script with AI" style="background: none; border: none; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; transition: color 0.3s; margin-right: 8px;">🔄</button>
          <label class="switch">
            <input type="checkbox" class="toggle-script" data-id="${config.id}" ${config.enabled ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
          <button class="btn-delete" data-id="${config.id}" title="Delete adjustment" style="background: none; border: none; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; transition: color 0.3s; margin-left: 2px;">🗑️</button>
        </div>
      `;

      customizationList.appendChild(item);
    });

    // Bind Toggle events
    document.querySelectorAll('.toggle-script').forEach(checkbox => {
      checkbox.addEventListener('change', async (e) => {
        const id = e.target.getAttribute('data-id');
        const enabled = e.target.checked;
        
        showStatus('Updating...');
        chrome.runtime.sendMessage({
          action: 'toggle-customization',
          id,
          enabled
        }, async (response) => {
          if (response && response.success) {
            showStatus('Customization updated');
            if (currentTab) {
              await chrome.tabs.reload(currentTab.id);
            }
          } else {
            showStatus('Update failed', '#ff4757');
            e.target.checked = !enabled; // revert
          }
        });
      });
    });

    // Bind Delete events
    document.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = btn.getAttribute('data-id');
        if (!confirm('Are you sure you want to delete this customization?')) return;

        showStatus('Deleting...');
        chrome.runtime.sendMessage({
          action: 'delete-customization',
          id
        }, async (response) => {
          if (response && response.success) {
            showStatus('Customization deleted');
            if (id === activeRefineId) {
              activeRefineId = null;
              updatePromptUIState(null);
              promptInput.placeholder = "e.g. Hide the sidebar, make links purple...";
            }
            await renderCustomizations();
            if (currentTab) {
              await chrome.tabs.reload(currentTab.id);
            }
          } else {
            showStatus('Delete failed', '#ff4757');
          }
        });
      });
    });

    // Bind Refine click events
    document.querySelectorAll('.btn-refine-script').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = btn.getAttribute('data-id');
        const promptText = btn.getAttribute('data-prompt');
        activeRefineId = id;
        updatePromptUIState({ id, prompt: promptText });
        
        // Focus and update input placeholder
        promptInput.focus();
        promptInput.placeholder = `Describe refinements for "${promptText}"...`;
      });
    });
  }

  // 7. Global Reset Button Click
  btnResetPage.addEventListener('click', async () => {
    if (!currentDomain) return;
    if (!confirm(`Reset all customizations on ${currentDomain}?`)) return;

    showStatus('Resetting...');
    chrome.runtime.sendMessage({
      action: 'delete-customization',
      domain: currentDomain
    }, async (response) => {
      if (response && response.success) {
        showStatus('Layout restored');
        activeRefineId = null;
        updatePromptUIState(null);
        promptInput.placeholder = "e.g. Hide the sidebar, make links purple...";
        await renderCustomizations();
        if (currentTab) {
          await chrome.tabs.reload(currentTab.id);
        }
      } else {
        showStatus('Reset failed', '#ff4757');
      }
    });
  });
  // 8. Auto-reload UI when storage configuration has changed
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'local') {
      if (changes.customizations) {
        await renderCustomizations();
      }
      if (changes.apiKey || changes.baseUrl || changes.model) {
        await loadSettings();
      }
    }
  });
});
