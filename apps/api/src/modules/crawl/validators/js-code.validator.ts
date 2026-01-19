/**
 * JavaScript Code Whitelist Validator
 *
 * Validates jsCode against an allowlist of permitted JavaScript operations
 * to prevent arbitrary code execution vulnerabilities.
 *
 * Security Issue: NP-SEC-002
 * Solution ID: SOL-NP-SEC-002-p5n9
 */

export interface JsCodeValidationResult {
  valid: boolean;
  blockedPatterns: string[];
  warnings: string[];
}

/**
 * Dangerous patterns that are always blocked.
 * These patterns can lead to arbitrary code execution, data exfiltration,
 * or prototype pollution attacks.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; name: string; reason: string }> = [
  // Code execution
  {
    pattern: /\beval\s*\(/gi,
    name: "eval()",
    reason: "Arbitrary code execution"
  },
  {
    pattern: /\bnew\s+Function\s*\(/g,
    name: "new Function()",
    reason: "Arbitrary code execution"
  },
  {
    pattern: /\bFunction\s*\(/g,
    name: "Function()",
    reason: "Arbitrary code execution"
  },
  {
    pattern: /\bsetTimeout\s*\(\s*["'`]/gi,
    name: "setTimeout with string",
    reason: "Arbitrary code execution via string evaluation"
  },
  {
    pattern: /\bsetInterval\s*\(\s*["'`]/gi,
    name: "setInterval with string",
    reason: "Arbitrary code execution via string evaluation"
  },

  // Network requests
  {
    pattern: /\bfetch\s*\(/gi,
    name: "fetch()",
    reason: "Network request - data exfiltration risk"
  },
  {
    pattern: /\bnew\s+XMLHttpRequest\s*\(/gi,
    name: "new XMLHttpRequest()",
    reason: "Network request - data exfiltration risk"
  },
  {
    pattern: /\bXMLHttpRequest\s*\(/gi,
    name: "XMLHttpRequest()",
    reason: "Network request - data exfiltration risk"
  },
  {
    pattern: /\bnew\s+WebSocket\s*\(/gi,
    name: "new WebSocket()",
    reason: "Network request - data exfiltration risk"
  },
  {
    pattern: /\bnavigator\s*\.\s*sendBeacon\s*\(/gi,
    name: "navigator.sendBeacon()",
    reason: "Network request - data exfiltration risk"
  },

  // Module imports
  {
    pattern: /\bimport\s*\(/gi,
    name: "dynamic import()",
    reason: "Module loading - arbitrary code execution"
  },
  {
    pattern: /\bimport\s+/gi,
    name: "import statement",
    reason: "Module loading - arbitrary code execution"
  },
  {
    pattern: /\brequire\s*\(/gi,
    name: "require()",
    reason: "Module loading - arbitrary code execution"
  },

  // Prototype pollution
  {
    pattern: /__proto__/gi,
    name: "__proto__",
    reason: "Prototype pollution attack vector"
  },
  {
    pattern: /\bconstructor\s*\.\s*prototype/gi,
    name: "constructor.prototype",
    reason: "Prototype pollution attack vector"
  },
  {
    pattern: /Object\s*\.\s*setPrototypeOf/gi,
    name: "Object.setPrototypeOf",
    reason: "Prototype pollution attack vector"
  },
  {
    pattern: /Object\s*\.\s*defineProperty/gi,
    name: "Object.defineProperty",
    reason: "Prototype pollution attack vector"
  },
  {
    pattern: /Object\s*\.\s*defineProperties/gi,
    name: "Object.defineProperties",
    reason: "Prototype pollution attack vector"
  },
  {
    pattern: /Reflect\s*\.\s*setPrototypeOf/gi,
    name: "Reflect.setPrototypeOf",
    reason: "Prototype pollution attack vector"
  },

  // Node.js specific (should not be available in browser but block anyway)
  {
    pattern: /\bprocess\s*\./gi,
    name: "process.*",
    reason: "Node.js process access"
  },
  {
    pattern: /\bglobal\s*\./gi,
    name: "global.*",
    reason: "Global object access"
  },
  {
    pattern: /\bglobalThis\s*\./gi,
    name: "globalThis.*",
    reason: "Global object access"
  },

  // DOM manipulation that could be dangerous
  {
    pattern: /\bdocument\s*\.\s*write\s*\(/gi,
    name: "document.write()",
    reason: "DOM injection - XSS risk"
  },
  {
    pattern: /\bdocument\s*\.\s*writeln\s*\(/gi,
    name: "document.writeln()",
    reason: "DOM injection - XSS risk"
  },
  {
    pattern: /\.innerHTML\s*=/gi,
    name: "innerHTML assignment",
    reason: "DOM injection - XSS risk"
  },
  {
    pattern: /\.outerHTML\s*=/gi,
    name: "outerHTML assignment",
    reason: "DOM injection - XSS risk"
  },
  {
    pattern: /\.insertAdjacentHTML\s*\(/gi,
    name: "insertAdjacentHTML()",
    reason: "DOM injection - XSS risk"
  },

  // Storage access
  {
    pattern: /\blocalStorage\s*\./gi,
    name: "localStorage",
    reason: "Storage access - data exfiltration risk"
  },
  {
    pattern: /\bsessionStorage\s*\./gi,
    name: "sessionStorage",
    reason: "Storage access - data exfiltration risk"
  },
  {
    pattern: /\bindexedDB\s*\./gi,
    name: "indexedDB",
    reason: "Storage access - data exfiltration risk"
  },
  {
    pattern: /\bdocument\s*\.\s*cookie/gi,
    name: "document.cookie",
    reason: "Cookie access - data exfiltration risk"
  },

  // Script injection
  {
    pattern: /\bdocument\s*\.\s*createElement\s*\(\s*["'`]script["'`]\s*\)/gi,
    name: "createElement('script')",
    reason: "Script injection"
  },

  // Obfuscation detection
  {
    pattern: /\\u00[0-9a-f]{2}/gi,
    name: "Unicode escape sequence",
    reason: "Potential obfuscation attempt"
  },
  {
    pattern: /\\x[0-9a-f]{2}/gi,
    name: "Hex escape sequence",
    reason: "Potential obfuscation attempt"
  },
  {
    pattern: /String\s*\.\s*fromCharCode/gi,
    name: "String.fromCharCode",
    reason: "Potential obfuscation attempt"
  },
  {
    pattern: /String\s*\.\s*fromCodePoint/gi,
    name: "String.fromCodePoint",
    reason: "Potential obfuscation attempt"
  },
  {
    pattern: /\batob\s*\(/gi,
    name: "atob()",
    reason: "Base64 decoding - potential obfuscation"
  },
  {
    pattern: /\bbtoa\s*\(/gi,
    name: "btoa()",
    reason: "Base64 encoding - potential data exfiltration"
  },

  // Bracket notation access to dangerous properties
  {
    pattern: /\[\s*["'`]eval["'`]\s*\]/gi,
    name: "['eval'] bracket access",
    reason: "Obfuscated eval access"
  },
  {
    pattern: /\[\s*["'`]Function["'`]\s*\]/gi,
    name: "['Function'] bracket access",
    reason: "Obfuscated Function access"
  },
  {
    pattern: /\[\s*["'`]constructor["'`]\s*\]/gi,
    name: "['constructor'] bracket access",
    reason: "Obfuscated constructor access"
  }
];

/**
 * Allowed patterns for safe DOM operations.
 * These are the only operations permitted in jsCode.
 */
const ALLOWED_OPERATIONS = [
  "window.scrollTo",
  "window.scrollBy",
  "window.scroll",
  "document.querySelector",
  "document.querySelectorAll",
  "document.getElementById",
  "document.getElementsByClassName",
  "document.getElementsByTagName",
  "element.click",
  "element.scrollIntoView",
  "element.focus",
  "element.blur",
  "setTimeout",
  "console.log",
  "console.warn",
  "console.error"
];

/**
 * Maximum allowed timeout value in milliseconds for setTimeout.
 */
const MAX_TIMEOUT_MS = 10000;

/**
 * Maximum allowed script length in characters.
 */
export const MAX_SCRIPT_LENGTH = 2000;

/**
 * Maximum number of scripts allowed per request.
 */
export const MAX_SCRIPTS_COUNT = 5;

/**
 * Validates a single JavaScript code string against the security allowlist.
 *
 * @param code - The JavaScript code to validate
 * @returns Validation result with blocked patterns and warnings
 */
export function validateJsCode(code: string): JsCodeValidationResult {
  const result: JsCodeValidationResult = {
    valid: true,
    blockedPatterns: [],
    warnings: []
  };

  if (!code || typeof code !== "string") {
    return result;
  }

  const trimmedCode = code.trim();
  if (trimmedCode.length === 0) {
    return result;
  }

  // Check script length
  if (trimmedCode.length > MAX_SCRIPT_LENGTH) {
    result.valid = false;
    result.blockedPatterns.push(`Script exceeds maximum length of ${MAX_SCRIPT_LENGTH} characters`);
  }

  // Remove comments to prevent hiding malicious code
  const codeWithoutComments = removeComments(trimmedCode);

  // Check for blocked patterns
  for (const { pattern, name, reason } of BLOCKED_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(codeWithoutComments)) {
      result.valid = false;
      result.blockedPatterns.push(`${name}: ${reason}`);
    }
  }

  // Validate setTimeout usage
  const setTimeoutWarning = validateSetTimeout(codeWithoutComments);
  if (setTimeoutWarning) {
    result.warnings.push(setTimeoutWarning);
  }

  return result;
}

/**
 * Validates an array of JavaScript code strings.
 *
 * @param scripts - Array of JavaScript code strings to validate
 * @returns Combined validation result
 */
export function validateJsCodeArray(scripts: string[]): JsCodeValidationResult {
  const result: JsCodeValidationResult = {
    valid: true,
    blockedPatterns: [],
    warnings: []
  };

  if (!scripts || !Array.isArray(scripts)) {
    return result;
  }

  // Check array size
  if (scripts.length > MAX_SCRIPTS_COUNT) {
    result.valid = false;
    result.blockedPatterns.push(`Too many scripts: ${scripts.length} exceeds maximum of ${MAX_SCRIPTS_COUNT}`);
  }

  // Validate each script
  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i];
    if (script === undefined) {
      continue;
    }
    const scriptResult = validateJsCode(script);
    if (!scriptResult.valid) {
      result.valid = false;
      result.blockedPatterns.push(
        ...scriptResult.blockedPatterns.map((p) => `Script[${i}]: ${p}`)
      );
    }
    result.warnings.push(
      ...scriptResult.warnings.map((w) => `Script[${i}]: ${w}`)
    );
  }

  return result;
}

/**
 * Removes JavaScript comments from code to prevent hiding malicious patterns.
 *
 * @param code - The JavaScript code
 * @returns Code with comments removed
 */
function removeComments(code: string): string {
  // Remove single-line comments
  let result = code.replace(/\/\/.*$/gm, "");

  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, "");

  return result;
}

/**
 * Validates setTimeout usage to ensure timeout values are within limits.
 *
 * @param code - The JavaScript code
 * @returns Warning message if timeout exceeds limit, undefined otherwise
 */
function validateSetTimeout(code: string): string | undefined {
  // Match setTimeout with function and timeout value
  const setTimeoutRegex = /setTimeout\s*\(\s*(?:function|\(|[a-zA-Z_$][\w$]*)\s*[^,]*,\s*(\d+)/g;
  let match: RegExpExecArray | null;

  while ((match = setTimeoutRegex.exec(code)) !== null) {
    const timeoutValue = match[1];
    if (timeoutValue === undefined) {
      continue;
    }
    const timeout = parseInt(timeoutValue, 10);
    if (timeout > MAX_TIMEOUT_MS) {
      return `setTimeout value ${timeout}ms exceeds maximum allowed ${MAX_TIMEOUT_MS}ms`;
    }
  }

  return undefined;
}

/**
 * Returns the list of allowed operations for documentation purposes.
 */
export function getAllowedOperations(): string[] {
  return [...ALLOWED_OPERATIONS];
}

/**
 * Returns the maximum timeout value for setTimeout.
 */
export function getMaxTimeoutMs(): number {
  return MAX_TIMEOUT_MS;
}
