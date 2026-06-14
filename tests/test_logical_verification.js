// Mock implementation of verify-dom logic for automated testing
function verifyDom(selector, mockDoc) {
  try {
    if (!selector) {
      return { exists: true, isLogicalFailure: false };
    }

    const el = mockDoc.querySelector(selector);
    if (!el) {
      return { exists: false };
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
        failureReason = `Element matched selector "${selector}" but contains placeholder value "${label}" in its content: "${textContent}"`;
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
        failureReason = `Element <${tagName}> matched selector "${selector}" but is completely empty (has no text and no children).`;
      }
    }

    return { exists: true, isLogicalFailure, failureReason };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

// Simple test framework
const assert = require('assert');

// Mock Document and elements helper
class MockElement {
  constructor(tagName, textContent = "", children = []) {
    this.tagName = tagName;
    this.textContent = textContent;
    this.innerText = textContent;
    this.children = children;
  }
}

class MockDocument {
  constructor(elementsMap) {
    this.elementsMap = elementsMap;
  }

  querySelector(selector) {
    return this.elementsMap[selector] || null;
  }
}

// Test cases
console.log("Running DOM verification logical checks tests...");

// Test case 1: Selector not found
{
  const doc = new MockDocument({});
  const res = verifyDom("#my-stats", doc);
  assert.deepStrictEqual(res, { exists: false });
  console.log("✓ Test Case 1 Passed: Selector not found correctly reported.");
}

// Test case 2: No selector specified
{
  const doc = new MockDocument({});
  const res = verifyDom("", doc);
  assert.deepStrictEqual(res, { exists: true, isLogicalFailure: false });
  console.log("✓ Test Case 2 Passed: No selector handled correctly.");
}

// Test case 3: Valid element
{
  const element = new MockElement("div", "Suggested Channels: PewDiePie, T-Series");
  const doc = new MockDocument({ "#my-stats": element });
  const res = verifyDom("#my-stats", doc);
  assert.deepStrictEqual(res, { exists: true, isLogicalFailure: false, failureReason: "" });
  console.log("✓ Test Case 3 Passed: Valid element correctly passes.");
}

// Test case 4: Undefined content
{
  const element = new MockElement("div", "Suggested Channels: undefined");
  const doc = new MockDocument({ "#my-stats": element });
  const res = verifyDom("#my-stats", doc);
  assert.strictEqual(res.exists, true);
  assert.strictEqual(res.isLogicalFailure, true);
  assert.ok(res.failureReason.includes("placeholder value \"undefined\""));
  console.log("✓ Test Case 4 Passed: 'undefined' detection caught.");
}

// Test case 5: Null content
{
  const element = new MockElement("span", "null count");
  const doc = new MockDocument({ ".error-box": element });
  const res = verifyDom(".error-box", doc);
  assert.strictEqual(res.exists, true);
  assert.strictEqual(res.isLogicalFailure, true);
  assert.ok(res.failureReason.includes("placeholder value \"null\""));
  console.log("✓ Test Case 5 Passed: 'null' detection caught.");
}

// Test case 6: [object Object] content
{
  const element = new MockElement("p", "Data: [object Object]");
  const doc = new MockDocument({ "#output": element });
  const res = verifyDom("#output", doc);
  assert.strictEqual(res.exists, true);
  assert.strictEqual(res.isLogicalFailure, true);
  assert.ok(res.failureReason.includes("placeholder value \"[object Object]\""));
  console.log("✓ Test Case 6 Passed: '[object Object]' detection caught.");
}

// Test case 7: Empty div
{
  const element = new MockElement("div", "");
  const doc = new MockDocument({ ".empty-container": element });
  const res = verifyDom(".empty-container", doc);
  assert.strictEqual(res.exists, true);
  assert.strictEqual(res.isLogicalFailure, true);
  assert.ok(res.failureReason.includes("is completely empty"));
  console.log("✓ Test Case 7 Passed: Completely empty element caught.");
}

// Test case 8: Empty img (should pass)
{
  const element = new MockElement("img", "");
  const doc = new MockDocument({ ".logo": element });
  const res = verifyDom(".logo", doc);
  assert.deepStrictEqual(res, { exists: true, isLogicalFailure: false, failureReason: "" });
  console.log("✓ Test Case 8 Passed: Naturally empty elements like img allowed.");
}

// Test case 9: Div with children but no text content (should pass)
{
  const child = new MockElement("span", "Hello");
  const element = new MockElement("div", "", [child]);
  const doc = new MockDocument({ ".container": element });
  const res = verifyDom(".container", doc);
  assert.deepStrictEqual(res, { exists: true, isLogicalFailure: false, failureReason: "" });
  console.log("✓ Test Case 9 Passed: Element with children but empty direct text allowed.");
}

console.log("\nAll tests completed successfully!");
