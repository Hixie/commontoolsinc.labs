import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  markdownTemplate,
  revealedText,
} from "../../../console/src/markdown.ts";
import { templateText } from "./template-text.ts";

const rendered = (
  source: string,
  revealed?: Readonly<Record<string, string>>,
): string => templateText(markdownTemplate(source, { revealed }));

describe("console/src/markdown", () => {
  describe("markdownTemplate()", () => {
    it("returns each character reference HTML defines as its character", () => {
      expect(
        rendered("a &amp; b &lt;c&gt; &#65;&#x42; &eacute;&mdash;&hellip;"),
      )
        .toContain("a & b <c> AB \u00e9\u2014\u2026");
    });

    it("returns a name HTML does not define, or one with no semicolon, as written, and an impossible code point as the replacement character", () => {
      expect(rendered("&notaname; &eacute &#0; &#xD800;")).toContain(
        "&notaname; &eacute \ufffd \ufffd",
      );
    });

    it("returns a web link as a link that opens apart from the console", () => {
      const text = rendered("[shop](https://shop.example/?a=1&amp;b=2)");

      expect(text).toContain('href="https://shop.example/?a=1&b=2"');
      expect(text).toContain('rel="noopener noreferrer"');
    });

    it("returns a script link as its label alone", () => {
      const text = rendered("[click](javascript:alert(1))");

      expect(text).toContain("click");
      expect(text).not.toContain("<a");
      expect(text).not.toContain("javascript:");
    });

    it("returns raw markup as nothing and an image as its description", () => {
      const text = rendered(
        '<img src="https://x.example/a.png" onerror="alert(1)">\n\n' +
          "![a red chair](https://x.example/chair.png)",
      );

      expect(text).toContain("a red chair");
      expect(text).not.toContain("<img");
      expect(text).not.toContain("x.example");
    });

    it("returns a code span as written, character references included", () => {
      expect(rendered("`a &amp; b`")).toContain("<code>a &amp; b</code>");
    });

    it("returns each revealed return referent in the text as its string, marked as found", () => {
      const text = rendered("Bought **cfh:v:22222**; see cfh:v:33333.", {
        "cfh:v:22222": "https://shop.example/item/7",
      });

      expect(text).toContain(
        '<code class="live-found" title="Found by an agent">https://shop.example/item/7</code>',
      );
      expect(text).toContain("see cfh:v:33333.");
    });

    it("returns a link to a revealed return referent with its destination as written", () => {
      const text = rendered("[the item](cfh:v:22222)", {
        "cfh:v:22222": "https://shop.example/item/7",
      });

      expect(text).not.toContain("<a");
      expect(text).not.toContain("https://shop.example/item/7");
    });

    it("returns a revealed return referent in a link's label as its token", () => {
      const text = rendered("[cfh:v:22222](https://elsewhere.example/)", {
        "cfh:v:22222": "https://shop.example/item/7",
      });

      expect(text).toContain('href="https://elsewhere.example/"');
      expect(text).toContain("cfh:v:22222");
      expect(text).not.toContain("https://shop.example/item/7");
    });

    it("returns each link as its label alone when links are off", () => {
      const text = templateText(
        markdownTemplate("Open [the form](https://shop.example/form).", {
          links: false,
        }),
      );

      expect(text).toContain("the form");
      expect(text).not.toContain("<a");
      expect(text).not.toContain("shop.example");
    });
  });

  describe("revealedText()", () => {
    it("returns plain text with each revealed return referent as its string, marked as found", () => {
      const text = templateText(
        revealedText("Could not buy cfh:v:22222; see cfh:v:33333.", {
          "cfh:v:22222": "the blue one",
        }),
      );

      expect(text).toBe(
        'Could not buy <code class="live-found" title="Found by an agent">the blue one</code>; see cfh:v:33333.',
      );
    });
  });
});
