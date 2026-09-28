/**
 * Tests of how `DomApplicator` removes a property from an element, run on
 * elements that a real browser creates. The unit tests in
 * `main-applicator.test.ts` run the same code against a mock document. These
 * tests check it against the browser's own rules for which properties set
 * which attributes. They run under deno-web-test, which registers tests
 * through `Deno.test`. The functions from `@std/testing/bdd` are therefore not
 * available here.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";

import { DomApplicator } from "../src/main/applicator.ts";
import type { VDomOp } from "../src/vdom-ops.ts";

/**
 * A custom element class that defines one property, `label`, with a getter and
 * a setter on the class, in the way a Lit component defines its properties.
 */
class LabeledBox extends HTMLElement {
  /** Number of instances constructed so far, in any document. */
  static constructed = 0;

  #label?: string;

  /** Constructs an instance, counting it. */
  constructor() {
    super();
    LabeledBox.constructed++;
  }

  /** Text the box shows. */
  get label(): string | undefined {
    return this.#label;
  }

  set label(value: string | undefined) {
    this.#label = value;
  }
}
customElements.define("x-labeled-box", LabeledBox);

/**
 * Creates a `tagName` element through a new `DomApplicator`, gives it
 * `attributes`, and sets `props` on it through the applicator. Then removes the
 * property `removedKey` through the applicator, and returns the element.
 */
function removeAfterSetting(
  tagName: string,
  attributes: Record<string, string>,
  props: Record<string, string | number | boolean>,
  removedKey: string,
): HTMLElement {
  const applicator = new DomApplicator({
    onEvent: () => {},
    onError: (error) => {
      throw error;
    },
  });
  applicator.applyBatch({
    batchId: 1,
    ops: [{ op: "create-element", nodeId: 1, tagName }],
  });
  const element = applicator.getNode(1) as HTMLElement;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  applicator.applyBatch({
    batchId: 2,
    ops: Object.entries(props).map(([key, value]): VDomOp => ({
      op: "set-prop",
      nodeId: 1,
      key,
      value,
    })),
  });
  applicator.applyBatch({
    batchId: 3,
    ops: [{ op: "remove-prop", nodeId: 1, key: removedKey }],
  });
  return element;
}

/**
 * Asserts that `element` has the same markup, and the same value for the
 * property `key`, as a newly created element with the same tag and
 * `attributes`.
 */
function assertPristine(
  element: HTMLElement,
  attributes: Record<string, string>,
  key: string,
): void {
  const pristine = document.createElement(element.localName);
  for (const [name, value] of Object.entries(attributes)) {
    pristine.setAttribute(name, value);
  }
  assertEquals(element.outerHTML, pristine.outerHTML);
  assertStrictEquals(Reflect.get(element, key), Reflect.get(pristine, key));
}

/**
 * Built-in properties to remove, each as the tag, the attributes the element
 * starts with, the property, and the value it is set to first.
 */
const builtInCases: [
  string,
  Record<string, string>,
  string,
  string | number | boolean,
][] = [
  ["input", {}, "title", "Hint"],
  ["input", {}, "placeholder", "Name"],
  ["div", {}, "className", "wide"],
  ["label", {}, "htmlFor", "name"],
  ["a", {}, "href", "https://example.com/"],
  ["a", {}, "href", ""],
  ["img", {}, "alt", ""],
  ["div", {}, "tabIndex", 3],
  ["div", {}, "tabIndex", -1],
  ["div", {}, "hidden", true],
  ["input", {}, "maxLength", 4],
  ["div", {}, "contentEditable", "true"],
  ["input", { type: "text" }, "value", "typed"],
  ["input", { type: "text", value: "default" }, "value", "typed"],
  ["textarea", {}, "value", "typed"],
  ["input", { type: "checkbox" }, "value", "yes"],
  ["input", { type: "checkbox" }, "checked", true],
  ["input", { type: "checkbox", checked: "" }, "checked", false],
  ["input", { type: "number" }, "valueAsNumber", 5],
  ["div", {}, "textContent", "text"],
];

for (const [tagName, attributes, key, value] of builtInCases) {
  const markup = `<${tagName}${
    Object.entries(attributes).map(([name, v]) => ` ${name}="${v}"`).join("")
  }>`;
  Deno.test(`removing ${key}, set to ${JSON.stringify(value)}, from ${markup} leaves it as though never set`, () => {
    const element = removeAfterSetting(tagName, attributes, {
      [key]: value,
    }, key);
    assertPristine(element, attributes, key);
  });
}

Deno.test("removing one property leaves the others in place", () => {
  const element = removeAfterSetting("input", {}, {
    title: "Hint",
    placeholder: "Name",
  }, "title");
  assertEquals(element.outerHTML, '<input placeholder="Name">');
});

Deno.test("removing an inherited property from a custom element removes its attribute", () => {
  const element = removeAfterSetting("x-labeled-box", {}, {
    title: "Hint",
    label: "Box",
  }, "title");
  assertEquals(element.outerHTML, "<x-labeled-box></x-labeled-box>");
  assertStrictEquals((element as LabeledBox).label, "Box");
});

Deno.test("removing a property from a custom element constructs no other instance", () => {
  const before = LabeledBox.constructed;
  removeAfterSetting("x-labeled-box", {}, { title: "Hint" }, "title");
  assertStrictEquals(LabeledBox.constructed, before + 1);
});

Deno.test("removing a property a custom element defines sets it to undefined", () => {
  const element = removeAfterSetting("x-labeled-box", {}, {
    title: "Hint",
    label: "Box",
  }, "label");
  assertStrictEquals((element as LabeledBox).label, undefined);
  assertEquals(
    element.outerHTML,
    '<x-labeled-box title="Hint"></x-labeled-box>',
  );
});
