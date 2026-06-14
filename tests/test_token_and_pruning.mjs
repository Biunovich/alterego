import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize clean local storage state
let localStore = {
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  customizations: {
    'script-old-no-token': {
      id: 'script-old-no-token',
      domain: 'example.com',
      prompt: 'Make it beautiful',
      css: 'body { color: green; }',
      js: 'console.log("hello");',
      enabled: true
      // No apiToken initially
    },
    'script-with-token': {
      id: 'script-with-token',
      domain: 'secure.com',
      prompt: 'Summarize page',
      css: '',
      js: 'askAlterEgoAI("summarize this page");',
      enabled: true,
      apiToken: 'valid-token-123'
    }
  }
};

let registeredScriptIds = new Set();
const messageListeners = [];
const startupListeners = [];
const installedListeners = [];
const onUpdatedListeners = [];
let fetchCalled = false;
let fetchOptions = null;

// Mock global fetch
global.fetch = async (url, options) => {
  fetchCalled = true;
  fetchOptions = options;
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        css: 'body { color: blue; }',
        js: 'console.log("hello");',
        verificationSelector: '.test-el',
        description: 'Mocked successful customization'
      }) } }]
    })
  };
};

// Mock Chrome Extension API
global.chrome = {
  sidePanel: {
    setPanelBehavior: async () => {}
  },
  runtime: {
    onMessage: {
      addListener: (fn) => {
        messageListeners.push(fn);
      }
    },
    sendMessage: async () => {},
    onStartup: {
      addListener: (fn) => {
        startupListeners.push(fn);
      }
    },
    onInstalled: {
      addListener: (fn) => {
        installedListeners.push(fn);
      }
    }
  },
  storage: {
    local: {
      get: async (keys) => {
        const res = {};
        const keysArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keysArr) {
          res[k] = localStore[k];
        }
        return res;
      },
      set: async (obj) => {
        Object.assign(localStore, obj);
      }
    },
    session: {
      get: async () => ({}),
      set: async () => {}
    },
    onChanged: {
      addListener: () => {}
    }
  },
  userScripts: {
    getRegisteredUserScripts: async () => {
      return Array.from(registeredScriptIds).map(id => ({ id }));
    },
    register: async (scripts) => {
      for (const s of scripts) {
        registeredScriptIds.add(s.id);
      }
    },
    unregister: async (obj) => {
      if (obj && obj.ids) {
        for (const id of obj.ids) {
          registeredScriptIds.delete(id);
        }
      }
    }
  },
  tabs: {
    query: async () => [{ id: 999, url: 'https://secure.com' }],
    reload: async (tabId) => {
      setTimeout(() => {
        for (const fn of onUpdatedListeners) {
          fn(tabId, { status: 'complete' });
        }
      }, 5);
    },
    sendMessage: async () => ({ exists: true, isLogicalFailure: false }),
    onUpdated: {
      addListener: (fn) => {
        onUpdatedListeners.push(fn);
      },
      removeListener: (fn) => {
        const idx = onUpdatedListeners.indexOf(fn);
        if (idx !== -1) {
          onUpdatedListeners.splice(idx, 1);
        }
      }
    }
  },
  scripting: {
    executeScript: async () => {}
  }
};

// Import background.js
console.log("Loading background.js for token and pruning tests...");
const backgroundPath = path.resolve(__dirname, '../background.js');
await import('file://' + backgroundPath);

const onMessageListener = messageListeners[0];

async function runTests() {
  console.log("\n--- Starting Security and Storage Tests ---");

  // 1. Verify that reinitializeScripts runs and generates a token for customizations missing one
  {
    console.log("\nTest 1: Startup token auto-generation...");
    // Call the registered onStartup listeners
    for (const fn of startupListeners) {
      await fn();
    }
    const oldScript = localStore.customizations['script-old-no-token'];
    assert.ok(oldScript.apiToken, "A capability token should have been generated on service worker load");
    assert.strictEqual(typeof oldScript.apiToken, 'string', "Token should be a string");
    assert.ok(oldScript.apiToken.length > 5, "Token should be a non-empty string");
    console.log("✓ Test 1 Passed: Old customization successfully assigned token:", oldScript.apiToken);
  }

  // 2. Verify Relayer Security (alterego-api-request-relay validation)
  {
    console.log("\nTest 2.1: Relay with valid token...");
    fetchCalled = false;
    let responseSent = null;
    const sendResponse = (res) => { responseSent = res; };

    // Send a message from secure.com containing the correct token
    onMessageListener(
      { action: 'alterego-api-request-relay', apiAction: 'ai-completion', token: 'valid-token-123', payload: { prompt: 'Translate hello' } },
      { tab: { url: 'https://secure.com' } },
      sendResponse
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(fetchCalled, true, "Fetch should be called for authorized token");
    assert.deepStrictEqual(responseSent, { success: true, result: '{"css":"body { color: blue; }","js":"console.log(\\"hello\\");","verificationSelector":".test-el","description":"Mocked successful customization"}' });
    console.log("✓ Test 2.1 Passed: Relayer successfully authorized matching token.");

    console.log("\nTest 2.2: Relay with invalid token...");
    fetchCalled = false;
    responseSent = null;

    onMessageListener(
      { action: 'alterego-api-request-relay', apiAction: 'ai-completion', token: 'attacker-token', payload: { prompt: 'Steal credentials' } },
      { tab: { url: 'https://secure.com' } },
      sendResponse
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(fetchCalled, false, "Fetch should NOT be called for unauthorized token");
    assert.strictEqual(responseSent.success, false, "Response should report failure");
    assert.ok(responseSent.error.includes("Unauthorized"), "Response error message should include Unauthorized");
    console.log("✓ Test 2.2 Passed: Relayer correctly blocked invalid capability token:", responseSent.error);

    console.log("\nTest 2.3: Relay from unmatching domain...");
    fetchCalled = false;
    responseSent = null;

    // Even with a valid token, sender domain must match the script domain
    onMessageListener(
      { action: 'alterego-api-request-relay', apiAction: 'ai-completion', token: 'valid-token-123', payload: { prompt: 'Translate hello' } },
      { tab: { url: 'https://malicious.com' } },
      sendResponse
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(fetchCalled, false, "Fetch should NOT be called if sender domain does not match script domain");
    assert.strictEqual(responseSent.success, false);
    assert.ok(responseSent.error.includes("Unauthorized"), "Response error should be Unauthorized");
    console.log("✓ Test 2.3 Passed: Relayer blocked valid token used on an unauthorized domain.");
  }

  // 3. Verify history context pruning and turn capping
  {
    console.log("\nTest 3: History context pruning and turn capping...");
    
    // We will test generate-customization save to verify pruning
    // Let's mock the local storage customizations to be empty
    localStore.customizations = {};

    let responseSent = null;
    const sendResponse = (res) => { responseSent = res; };

    // Trigger generate-customization
    onMessageListener(
      {
        action: 'generate-customization',
        prompt: 'Clean layout',
        domain: 'prune-test.com',
        context: '<div>Huge DOM context here...</div>'.repeat(100),
        targetedContext: '<span>Target element context...</span>'.repeat(50),
        targetSelector: '.test-el',
        tabId: 999
      },
      {},
      sendResponse
    );

    await new Promise(resolve => setTimeout(resolve, 1000)); // wait for generation & verification (grace period is 400ms)

    const scriptKeys = Object.keys(localStore.customizations);
    assert.strictEqual(scriptKeys.length, 1, "Should save one customization");
    const customization = localStore.customizations[scriptKeys[0]];
    
    assert.ok(customization.apiToken, "Generated customization must contain an apiToken");
    assert.ok(customization.history, "Generated customization must contain a history array");
    
    // History should have exactly 2 messages initially (1 user initial, 1 assistant response)
    assert.strictEqual(customization.history.length, 2);
    
    // Verify that the user message in history has been pruned
    const userMsg = customization.history[0];
    assert.strictEqual(userMsg.role, 'user');
    assert.ok(!userMsg.content.includes("Huge DOM context here"), "History should not contain the original large DOM context");
    assert.ok(!userMsg.content.includes("Target element context"), "History should not contain the original large targeted context");
    assert.ok(userMsg.content.includes("[Simplified Webpage DOM Context Pruned]"), "History should contain the pruning placeholder");
    assert.ok(userMsg.content.includes("[Targeted Element Context Pruned]"), "History should contain the targeted context pruning placeholder");
    
    console.log("✓ Test 3 Passed: DOM context successfully stripped from history record.");
  }

  console.log("\nAll security and storage tests passed successfully!");
}

runTests().catch(err => {
  console.error("Tests failed:", err);
  process.exit(1);
});
