import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';

// Define __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock storage databases
let localStore = {
  customizations: {
    'script-1': {
      id: 'script-1',
      domain: 'example.com',
      prompt: 'Make it red',
      css: 'body { color: red; }',
      js: 'console.log("red");',
      enabled: true
    },
    'script-2': {
      id: 'script-2',
      domain: 'example.com',
      prompt: 'Make it big',
      css: 'body { font-size: 20px; }',
      js: 'console.log("big");',
      enabled: true
    },
    'script-other': {
      id: 'script-other',
      domain: 'other.com',
      prompt: 'Make it blue',
      css: 'body { color: blue; }',
      js: 'console.log("blue");',
      enabled: true
    }
  }
};
let sessionStore = {};
let registeredScriptIds = new Set(['script-1', 'script-2', 'script-other']);

// Setup global chrome mocks
const messageListeners = [];
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
      addListener: () => {}
    },
    onInstalled: {
      addListener: () => {}
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
      get: async (keys) => {
        const res = {};
        const keysArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keysArr) {
          res[k] = sessionStore[k];
        }
        return res;
      },
      set: async (obj) => {
        Object.assign(sessionStore, obj);
      }
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
    query: async () => [{ id: 999, url: 'https://example.com' }],
    reload: async () => {},
    sendMessage: async () => ({ exists: true })
  },
  scripting: {
    executeScript: async () => {}
  }
};

// Import background.js to register message handlers
console.log("Loading background.js...");
const backgroundPath = path.resolve(__dirname, '../background.js');
await import('file://' + backgroundPath);

console.log("Number of message listeners registered:", messageListeners.length);
assert.ok(messageListeners.length > 0, "No message listeners were registered by background.js");

const onMessageListener = messageListeners[0];

// Test Cases
async function runTests() {
  console.log("\nRunning test suite...");

  // Test case 1: delete-customization by script ID
  {
    console.log("\n--- Test Case 1: Delete customization by ID ---");
    let responseSent = null;
    const sendResponse = (res) => {
      responseSent = res;
    };

    const isHandled = onMessageListener(
      { action: 'delete-customization', id: 'script-1' },
      {},
      sendResponse
    );

    assert.strictEqual(isHandled, true, "Listener should return true for delete-customization");
    
    // Wait for async handler execution
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.deepStrictEqual(responseSent, { success: true });
    assert.strictEqual(localStore.customizations['script-1'], undefined, "Customization should be deleted from local storage");
    assert.strictEqual(registeredScriptIds.has('script-1'), false, "Script should be unregistered");
    assert.strictEqual(localStore.customizations['script-2'] !== undefined, true, "Other scripts should remain");
    console.log("✓ Test Case 1 Passed: Deletion by ID works perfectly.");
  }

  // Test case 2: toggle-customization (disable)
  {
    console.log("\n--- Test Case 2: Toggle customization (disable) ---");
    let responseSent = null;
    const sendResponse = (res) => {
      responseSent = res;
    };

    const isHandled = onMessageListener(
      { action: 'toggle-customization', id: 'script-2', enabled: false },
      {},
      sendResponse
    );

    assert.strictEqual(isHandled, true, "Listener should return true for toggle-customization");
    
    // Wait for async handler execution
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.deepStrictEqual(responseSent, { success: true });
    assert.strictEqual(localStore.customizations['script-2'].enabled, false, "Customization should be disabled");
    assert.strictEqual(registeredScriptIds.has('script-2'), false, "Script should be unregistered when disabled");
    console.log("✓ Test Case 2 Passed: Toggling off script works perfectly.");
  }

  // Test case 3: toggle-customization (enable)
  {
    console.log("\n--- Test Case 3: Toggle customization (enable) ---");
    let responseSent = null;
    const sendResponse = (res) => {
      responseSent = res;
    };

    const isHandled = onMessageListener(
      { action: 'toggle-customization', id: 'script-2', enabled: true },
      {},
      sendResponse
    );

    assert.strictEqual(isHandled, true, "Listener should return true for toggle-customization");
    
    // Wait for async handler execution
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.deepStrictEqual(responseSent, { success: true });
    assert.strictEqual(localStore.customizations['script-2'].enabled, true, "Customization should be enabled");
    assert.strictEqual(registeredScriptIds.has('script-2'), true, "Script should be registered when enabled");
    console.log("✓ Test Case 3 Passed: Toggling on script works perfectly.");
  }

  // Test case 4: delete-customization by domain (Reset)
  {
    console.log("\n--- Test Case 4: Reset all customizations by domain ---");
    let responseSent = null;
    const sendResponse = (res) => {
      responseSent = res;
    };

    const isHandled = onMessageListener(
      { action: 'delete-customization', domain: 'example.com' },
      {},
      sendResponse
    );

    assert.strictEqual(isHandled, true, "Listener should return true for delete-customization by domain");
    
    // Wait for async handler execution
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.deepStrictEqual(responseSent, { success: true });
    assert.strictEqual(localStore.customizations['script-2'], undefined, "All example.com customizations should be deleted");
    assert.strictEqual(registeredScriptIds.has('script-2'), false, "example.com script should be unregistered");
    assert.strictEqual(localStore.customizations['script-other'] !== undefined, true, "Other domain script should remain");
    assert.strictEqual(registeredScriptIds.has('script-other'), true, "Other domain script should remain registered");
    console.log("✓ Test Case 4 Passed: Global reset by domain works perfectly.");
  }

  console.log("\nAll background handlers tests completed successfully!");
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
