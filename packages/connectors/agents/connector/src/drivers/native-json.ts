/** Fragment tokenizer whose nesting stack spills to a private scratch file. */

/** Structural tokens and bounded scalar fragments consumed by native projections. */
export type NativeJsonToken =
  | {
    name:
      | "startObject"
      | "endObject"
      | "startArray"
      | "endArray"
      | "startKey"
      | "endKey"
      | "startString"
      | "endString"
      | "startNumber"
      | "endNumber";
  }
  | { name: "stringChunk" | "numberChunk"; value: string }
  | { name: "trueValue" | "falseValue" | "nullValue"; value: boolean | null };

/** Stores parser return states in one fixed page, spilling deeper pages to disk. */
class NestingStack implements Disposable {
  readonly #buffer = new Uint8Array(4096);
  readonly #directory?: string;
  #length = 0;
  #base = 0;
  #dirty = false;
  #file?: Deno.FsFile;
  #path?: string;

  /** Selects the private directory used if nesting exceeds the resident page. */
  constructor(directory?: string) {
    this.#directory = directory;
  }

  /** Number of open native containers. */
  get length(): number {
    return this.#length;
  }

  /** Pushes the state to restore when the current container ends. */
  push(state: number): void {
    this.#load(this.#length);
    this.#buffer[this.#length++ - this.#base] = state;
    this.#dirty = true;
  }

  /** Restores the enclosing container's parser state. */
  pop(): number {
    if (this.#length === 0) {
      throw new Error("Native JSON has an unmatched closing delimiter");
    }
    this.#load(--this.#length);
    return this.#buffer[this.#length - this.#base];
  }

  #load(index: number): void {
    const base = Math.floor(index / this.#buffer.length) * this.#buffer.length;
    if (base === this.#base) return;
    if (!this.#file) {
      this.#path = Deno.makeTempFileSync({
        dir: this.#directory,
        prefix: "native-json-stack-",
      });
      this.#file = Deno.openSync(this.#path, { read: true, write: true });
    }
    if (this.#dirty) {
      this.#file.seekSync(this.#base, Deno.SeekMode.Start);
      let offset = 0;
      while (offset < this.#buffer.length) {
        offset += this.#file.writeSync(this.#buffer.subarray(offset));
      }
    }
    this.#file.seekSync(base, Deno.SeekMode.Start);
    this.#buffer.fill(0);
    let offset = 0;
    while (offset < this.#buffer.length) {
      const count = this.#file.readSync(this.#buffer.subarray(offset));
      if (count === null) break;
      offset += count;
    }
    this.#base = base;
    this.#dirty = false;
  }

  /** Removes the scratch stack after completion, failure, or consumer cancellation. */
  [Symbol.dispose](): void {
    this.#file?.close();
    if (this.#path) Deno.removeSync(this.#path);
  }
}

// deno-lint-ignore no-control-regex -- Unescaped JSON control characters end a string fragment.
const STRING = /[^"\\\x00-\x1f]+/y;
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Parses a sequence of native JSON objects. Scalars are emitted per input
 * fragment. Container return states occupy one byte per level on disk.
 */
export class NativeJsonTokenizer implements Disposable {
  readonly #stack: NestingStack;
  #state = 0;
  #mode: "syntax" | "string" | "escape" | "unicode" | "number" | "literal" =
    "syntax";
  #key = false;
  #unicode = 0;
  #unicodeDigits = 0;
  #number = 0;
  #literal = "";
  #literalOffset = 0;

  /** Configures the private scratch location for deeply nested input. */
  constructor(directory?: string) {
    this.#stack = new NestingStack(directory);
  }

  /** Tokenizes one decoded UTF-8 fragment without retaining it between calls. */
  *write(text: string): Generator<NativeJsonToken> {
    let index = 0;
    while (index < text.length) {
      const character = text[index];
      if (this.#mode === "string") {
        STRING.lastIndex = index;
        const run = STRING.exec(text);
        if (run) {
          index = STRING.lastIndex;
          yield { name: "stringChunk", value: run[0] };
          continue;
        }
        index++;
        if (character === '"') {
          this.#mode = "syntax";
          if (this.#key) {
            this.#state = 3;
            yield { name: "endKey" };
          } else yield { name: "endString" };
        } else if (character === "\\") this.#mode = "escape";
        else {throw new Error(
            "Native JSON contains an unescaped control character",
          );}
        continue;
      }
      if (this.#mode === "escape") {
        index++;
        if (character === "u") {
          this.#mode = "unicode";
          this.#unicode = 0;
          this.#unicodeDigits = 0;
        } else {
          const value = ESCAPES[character];
          if (value === undefined) {
            throw new Error("Native JSON has an invalid string escape");
          }
          this.#mode = "string";
          yield { name: "stringChunk", value };
        }
        continue;
      }
      if (this.#mode === "unicode") {
        if (!/^[0-9a-f]$/i.test(character)) {
          throw new Error("Native JSON has an invalid Unicode escape");
        }
        this.#unicode = this.#unicode * 16 + parseInt(character, 16);
        index++;
        if (++this.#unicodeDigits === 4) {
          this.#mode = "string";
          yield {
            name: "stringChunk",
            value: String.fromCharCode(this.#unicode),
          };
        }
        continue;
      }
      if (this.#mode === "literal") {
        if (character !== this.#literal[this.#literalOffset++]) {
          throw new Error("Native JSON has an invalid literal");
        }
        index++;
        if (this.#literalOffset === this.#literal.length) {
          this.#mode = "syntax";
          yield this.#literal === "true"
            ? { name: "trueValue", value: true }
            : this.#literal === "false"
            ? { name: "falseValue", value: false }
            : { name: "nullValue", value: null };
        }
        continue;
      }
      if (this.#mode === "number") {
        const start = index;
        while (index < text.length) {
          const next = this.#numberState(text[index]);
          if (next === -1) break;
          this.#number = next;
          index++;
        }
        if (index > start) {
          yield { name: "numberChunk", value: text.slice(start, index) };
        }
        if (index < text.length) {
          if (![2, 3, 5, 8].includes(this.#number)) {
            throw new Error("Native JSON has an incomplete number");
          }
          this.#mode = "syntax";
          yield { name: "endNumber" };
        }
        continue;
      }
      if (
        character === " " || character === "\n" || character === "\r" ||
        character === "\t"
      ) {
        index++;
        continue;
      }
      if (this.#state === 1 || this.#state === 2) {
        if (character === "}" && this.#state === 1) {
          this.#state = this.#stack.pop();
          index++;
          yield { name: "endObject" };
        } else {
          if (character !== '"') {
            throw new Error("Native JSON expected an object key");
          }
          this.#key = true;
          this.#mode = "string";
          index++;
          yield { name: "startKey" };
        }
        continue;
      }
      if (this.#state === 3) {
        if (character !== ":") throw new Error("Native JSON expected a colon");
        this.#state = 4;
        index++;
        continue;
      }
      if (this.#state === 5 || this.#state === 8) {
        const object = this.#state === 5;
        index++;
        if (character === ",") this.#state = object ? 2 : 7;
        else if (character === (object ? "}" : "]")) {
          this.#state = this.#stack.pop();
          yield { name: object ? "endObject" : "endArray" };
        } else {throw new Error(
            "Native JSON expected a comma or closing delimiter",
          );}
        continue;
      }
      if (this.#state === 6 && character === "]") {
        this.#state = this.#stack.pop();
        index++;
        yield { name: "endArray" };
        continue;
      }
      if (this.#state === 0 && character !== "{") {
        throw new Error("Native JSON records must be objects");
      }
      this.#state = this.#state === 4
        ? 5
        : this.#state === 6 || this.#state === 7
        ? 8
        : 0;
      this.#key = false;
      if (character === "{" || character === "[") {
        this.#stack.push(this.#state);
        this.#state = character === "{" ? 1 : 6;
        index++;
        yield { name: character === "{" ? "startObject" : "startArray" };
      } else if (character === '"') {
        this.#mode = "string";
        index++;
        yield { name: "startString" };
      } else if (character === "-" || (character >= "0" && character <= "9")) {
        this.#mode = "number";
        this.#number = 0;
        yield { name: "startNumber" };
      } else if (character === "t" || character === "f" || character === "n") {
        this.#literal = character === "t"
          ? "true"
          : character === "f"
          ? "false"
          : "null";
        this.#literalOffset = 0;
        this.#mode = "literal";
      } else throw new Error("Native JSON expected a value");
    }
  }

  #numberState(character: string): number {
    if (character >= "0" && character <= "9") {
      if (this.#number === 0 || this.#number === 1) {
        return character === "0" ? 2 : 3;
      }
      if (this.#number === 3 || this.#number === 5 || this.#number === 8) {
        return this.#number;
      }
      if (this.#number === 4) return 5;
      if (this.#number === 6 || this.#number === 7) return 8;
    }
    if (character === "-" && this.#number === 0) return 1;
    if (character === "." && (this.#number === 2 || this.#number === 3)) {
      return 4;
    }
    if (
      (character === "e" || character === "E") &&
      [2, 3, 5].includes(this.#number)
    ) return 6;
    if ((character === "-" || character === "+") && this.#number === 6) {
      return 7;
    }
    return -1;
  }

  /** Rejects incomplete terminal records after the final input fragment. */
  finish(): void {
    if (
      this.#mode !== "syntax" || this.#stack.length !== 0 || this.#state !== 0
    ) throw new Error("Native JSON has an incomplete terminal record");
  }

  /** Releases the parser's private nesting stack. */
  [Symbol.dispose](): void {
    this.#stack[Symbol.dispose]();
  }
}
