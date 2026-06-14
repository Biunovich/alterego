/**
 * AlterEgo Content Script: Context Extractor & Element Picker
 * This script is dynamically injected to retrieve page structure and handle element picking.
 */

(function () {
  // Prevent double-initialization
  if (window.hasAlterEgoExtractor) {
    // Re-verify listener is active
    return;
  }
  window.hasAlterEgoExtractor = true;

  let lastHoveredElement = null;
  let originalOutline = '';
  let originalOutlineOffset = '';
  let isPickingActive = false;

  // Compute a clean, robust, unique CSS selector for any element
  function getUniqueSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

    // Helper to check for dynamic classes or IDs
    function isDynamic(val) {
      return !val || /^\d|:\w+:|__|\d{4,}/.test(val);
    }

    // 1. Check for stable data attributes or name
    const stableAttrs = ['data-testid', 'name', 'role', 'placeholder', 'aria-label'];
    for (let attr of stableAttrs) {
      if (el.hasAttribute(attr)) {
        const val = el.getAttribute(attr);
        if (val && val.trim().length > 0 && val.length < 50) {
          return `${el.tagName.toLowerCase()}[${attr}="${val.trim().replace(/"/g, '\\"')}"]`;
        }
      }
    }

    // 2. Check for stable ID
    if (el.id && !isDynamic(el.id)) {
      return `#${el.id}`;
    }

    const path = [];
    let current = el;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.nodeName.toLowerCase();
      
      if (selector === 'body' || selector === 'html') {
        path.unshift(selector);
        break;
      }

      // Check stable attribute on the ancestor
      let foundStable = false;
      for (let attr of stableAttrs) {
        if (current.hasAttribute(attr)) {
          const val = current.getAttribute(attr);
          if (val && val.trim().length > 0 && val.length < 50) {
            selector += `[${attr}="${val.trim().replace(/"/g, '\\"')}"]`;
            foundStable = true;
            break;
          }
        }
      }

      if (!foundStable) {
        if (current.id && !isDynamic(current.id)) {
          selector = `#${current.id}`;
          path.unshift(selector);
          break; // Stop climbing if we hit a stable ID
        }

        // Filter out dynamic-looking utility classes
        if (current.className && typeof current.className === 'string') {
          const classes = current.className.trim().split(/\s+/)
            .filter(c => {
              return c.length > 0 && 
                     !c.startsWith('alterego-') && 
                     !/\d|__/.test(c) && 
                     c.length < 25;
            });
          if (classes.length > 0) {
            selector += '.' + classes.slice(0, 2).join('.');
          }
        }

        // Calculate nth-of-type if it has siblings of same tag
        let sibling = current.previousElementSibling;
        let nth = 1;
        while (sibling) {
          if (sibling.nodeName === current.nodeName) {
            nth++;
          }
          sibling = sibling.previousElementSibling;
        }

        let siblingNext = current.nextElementSibling;
        let hasTagSiblings = false;
        while (siblingNext) {
          if (siblingNext.nodeName === current.nodeName) {
            hasTagSiblings = true;
            break;
          }
          siblingNext = siblingNext.nextElementSibling;
        }

        if (nth > 1 || hasTagSiblings) {
          selector += `:nth-of-type(${nth})`;
        }
      }

      path.unshift(selector);
      current = current.parentNode;
    }

    return path.join(' > ');
  }

  // Extract focused DOM structure around a specific selector
  function getTargetedDOMContext(selector) {
    if (!selector) return '';
    try {
      const el = document.querySelector(selector);
      if (!el) return `[Element for selector "${selector}" not found]`;

      const parent = el.parentElement || el;
      let desc = `Ancestors & Siblings of targeted element:\n`;
      
      function serializeNode(node, isTarget) {
        let tag = node.tagName.toLowerCase();
        let str = `<${tag}`;
        if (node.id) str += ` id="${node.id}"`;
        if (node.className && typeof node.className === 'string') {
          str += ` class="${node.className.trim()}"`;
        }
        for (let attr of ['placeholder', 'name', 'type', 'role', 'aria-label', 'data-testid']) {
          if (node.hasAttribute(attr)) {
            str += ` ${attr}="${node.getAttribute(attr)}"`;
          }
        }
        str += `>${isTarget ? '  <-- TARGET ELEMENT' : ''}`;
        const txt = node.textContent ? node.textContent.trim().substring(0, 50) : '';
        if (txt) str += ` (Text: "${txt}")`;
        str += `</${tag}>`;
        return str;
      }

      desc += `Parent: ${serializeNode(parent, false)}\n`;
      for (let child of parent.children) {
        const isTarget = (child === el);
        desc += `  ${isTarget ? '=>' : '  '} ${serializeNode(child, isTarget)}\n`;
        if (isTarget) {
          for (let gchild of child.children) {
            desc += `       - child: ${serializeNode(gchild, false)}\n`;
          }
        }
      }
      return desc;
    } catch (err) {
      return `[Failed to extract targeted context: ${err.message}]`;
    }
  }

  // Traverse the DOM to build a lightweight, semantic layout outline
  function getSimplifiedDOMContext() {
    const lines = [];
    const maxDepth = 8; // Increased from 4 to 8 for deep SPA pages
    const maxNodes = 200; // Increased from 120 to 200
    let nodeCount = 0;

    function traverse(node, depth = 0) {
      if (depth > maxDepth || !node || nodeCount >= maxNodes) return;

      const skipTags = ['SCRIPT', 'STYLE', 'SVG', 'PATH', 'NOSCRIPT', 'IFRAME', 'HEAD', 'HTML', 'LINK', 'META'];
      if (skipTags.includes(node.tagName)) return;

      const hasClassOrId = node.className || node.id;
      const isSemantic = ['HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'ARTICLE', 'SECTION', 'FORM', 'UL', 'OL', 'H1', 'H2', 'H3', 'BUTTON', 'A'].includes(node.tagName);
      const isCustomElement = node.tagName.includes('-'); // Capture custom component elements (e.g. ytd-*)

      if (isSemantic || hasClassOrId || isCustomElement) {
        nodeCount++;
        let indent = '  '.repeat(depth);
        let desc = `${indent}<${node.tagName.toLowerCase()}`;
        if (node.id) desc += ` id="${node.id}"`;
        if (node.className && typeof node.className === 'string') {
          // Filter out very long utility classes
          const classes = node.className.trim().split(/\s+/)
            .filter(c => c.length > 0 && c.length < 30 && !/\d/.test(c))
            .slice(0, 3)
            .join(' ');
          if (classes) desc += ` class="${classes}"`;
        }
        
        // Also capture critical attributes for links
        if (node.tagName === 'A' && node.getAttribute('href')) {
          desc += ` href="${node.getAttribute('href')}"`;
        }
        
        desc += '>';
        
        // Include text preview if short
        const directText = Array.from(node.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .join('')
          .substring(0, 40);
        if (directText) {
          desc += ` (Text: "${directText}")`;
        }

        lines.push(desc);
      }

      for (let child of node.children) {
        traverse(child, depth + 1);
      }
    }

    traverse(document.body);
    return lines.join('\n');
  }

  // Visual Picker Event Handlers
  function onMouseOver(e) {
    if (!isPickingActive) return;
    e.stopPropagation();

    // Clean previous highlight
    if (lastHoveredElement && lastHoveredElement !== e.target) {
      lastHoveredElement.style.outline = originalOutline;
      lastHoveredElement.style.outlineOffset = originalOutlineOffset;
    }

    lastHoveredElement = e.target;
    originalOutline = lastHoveredElement.style.outline;
    originalOutlineOffset = lastHoveredElement.style.outlineOffset;

    // Apply high-contrast red outline highlight
    lastHoveredElement.style.outline = '3px solid #ff4757';
    lastHoveredElement.style.outlineOffset = '-3px';
  }

  function onMouseOut(e) {
    if (!isPickingActive) return;
    if (lastHoveredElement === e.target) {
      lastHoveredElement.style.outline = originalOutline;
      lastHoveredElement.style.outlineOffset = originalOutlineOffset;
      lastHoveredElement = null;
    }
  }

  function onClick(e) {
    if (!isPickingActive) return;
    e.preventDefault();
    e.stopPropagation();

    // End picking session
    stopPicking();

    const selector = getUniqueSelector(e.target);
    console.log('[AlterEgo] Picked selector:', selector);

    // Send selection back to extension
    chrome.runtime.sendMessage({
      action: 'element-picked',
      selector: selector,
      tagName: e.target.tagName.toLowerCase()
    });
  }

  function startPicking() {
    if (isPickingActive) return;
    isPickingActive = true;
    document.body.style.cursor = 'crosshair';

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
    console.log('[AlterEgo] Selector picking started.');
  }

  function stopPicking() {
    if (!isPickingActive) return;
    isPickingActive = false;
    document.body.style.cursor = 'default';

    if (lastHoveredElement) {
      lastHoveredElement.style.outline = originalOutline;
      lastHoveredElement.style.outlineOffset = originalOutlineOffset;
      lastHoveredElement = null;
    }

    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onClick, true);
    console.log('[AlterEgo] Selector picking stopped.');
  }

  // Listen for custom script status events from USER_SCRIPT world and bridge to background
  window.addEventListener('alterego-script-status', (e) => {
    console.log('[AlterEgo] Caught status from user script world:', e.detail);
    chrome.runtime.sendMessage({
      action: 'report-script-status',
      status: e.detail.status,
      error: e.detail.error
    }).catch(err => {
      console.warn('[AlterEgo] Failed to relay script status to background:', err);
    });
  });

  // Keep old listener for backward compatibility with older generated scripts
  window.addEventListener('alterego-script-error', (e) => {
    console.log('[AlterEgo] Caught legacy error from user script world:', e.detail);
    chrome.runtime.sendMessage({
      action: 'report-script-status',
      status: 'error',
      error: e.detail
    }).catch(err => {
      console.warn('[AlterEgo] Failed to relay legacy script error to background:', err);
    });
  });

  // Listen for API requests from USER_SCRIPT world and relay them to background
  window.addEventListener('alterego-api-request', (e) => {
    const { requestId, action, token, payload } = e.detail || {};
    console.log('[AlterEgo] Relaying API request from user script:', action, requestId);
    chrome.runtime.sendMessage({
      action: 'alterego-api-request-relay',
      apiAction: action,
      token: token,
      payload: payload
    }).then(response => {
      console.log('[AlterEgo] Received API response from background, sending back to user script:', requestId);
      window.dispatchEvent(new CustomEvent(`alterego-api-response-${requestId}`, {
        detail: response
      }));
    }).catch(err => {
      console.warn('[AlterEgo] Failed to process API request:', err);
      window.dispatchEvent(new CustomEvent(`alterego-api-response-${requestId}`, {
        detail: { success: false, error: err.message }
      }));
    });
  });

  // Handle messages from the Side Panel / Background Script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'get-context') {
      const context = getSimplifiedDOMContext();
      const targetedContext = message.targetSelector ? getTargetedDOMContext(message.targetSelector) : '';
      const title = document.title;
      const url = window.location.href;
      sendResponse({ context, targetedContext, title, url });
    } else if (message.action === 'start-picking') {
      startPicking();
      sendResponse({ status: 'picking_started' });
    } else if (message.action === 'stop-picking') {
      stopPicking();
      sendResponse({ status: 'picking_stopped' });
    } else if (message.action === 'verify-dom') {
      try {
        if (!message.selector) {
          sendResponse({ exists: true, isLogicalFailure: false });
          return;
        }

        const el = document.querySelector(message.selector);
        if (!el) {
          sendResponse({ exists: false });
          return;
        }

        let isLogicalFailure = false;
        let failureReason = "";

        const textContent = (el.innerText || el.textContent || "").trim();

        // 1. Check for invalid placeholder patterns (undefined, null, NaN, [object Object])
        const invalidPatterns = [
          { pattern: /\bundefined\b/i, label: "undefined" },
          { pattern: /\bnull\b/i, label: "null" },
          { pattern: /\bNaN\b/, label: "NaN" },
          { pattern: /\[object\s+Object\]/i, label: "[object Object]" }
        ];

        for (const { pattern, label } of invalidPatterns) {
          if (pattern.test(textContent)) {
            isLogicalFailure = true;
            failureReason = `Element matched selector "${message.selector}" but contains placeholder value "${label}" in its content: "${textContent}"`;
            break;
          }
        }

        // 2. Check if element is completely empty and should not be
        if (!isLogicalFailure) {
          const naturallyEmptyTags = ['img', 'input', 'textarea', 'select', 'canvas', 'video', 'audio', 'iframe', 'svg', 'button'];
          const tagName = el.tagName.toLowerCase();
          const hasNoChildren = el.children.length === 0;
          const hasNoText = textContent === "";

          if (hasNoText && hasNoChildren && !naturallyEmptyTags.includes(tagName)) {
            isLogicalFailure = true;
            failureReason = `Element <${tagName}> matched selector "${message.selector}" but is completely empty (has no text and no children).`;
          }
        }

        sendResponse({ exists: true, isLogicalFailure, failureReason });
      } catch (err) {
        console.warn('[AlterEgo] DOM verification error:', err);
        sendResponse({ exists: false, error: err.message });
      }
    }
  });
})();
