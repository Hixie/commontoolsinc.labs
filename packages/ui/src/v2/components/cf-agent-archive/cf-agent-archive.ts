/** Displays a pinned native archive with one catalog page and one byte page. */

import type {
  AgentArchiveCatalog,
  ArchivedCheckout,
  ArchivedSession,
} from "@commonfabric/agents-connector/archive";
import {
  type ArchivePage,
  ArchivePinOwner,
  type ArchiveRecord,
} from "@commonfabric/memory/v2/archive";
import type { CellHandle } from "@commonfabric/runtime-client";
import { css, html, nothing } from "lit";
import { BaseElement } from "../../core/base-element.ts";

type ArchiveCell = Pick<
  CellHandle<AgentArchiveCatalog | undefined>,
  "archive" | "subscribe"
>;
type Selection = { cell: ArchiveCell; catalog: AgentArchiveCatalog };
type Pinned = Selection & { pin: string; owner: ArchivePinOwner };

/** An imperative reader whose native values remain in the browser component. */
export class CFAgentArchive extends BaseElement {
  static override properties = { value: { attribute: false } };
  static override styles = css`
    :host {
      display: block;
      font: inherit;
      color: inherit;
    }
    nav,
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: .5rem;
      align-items: center;
      margin: .75rem 0;
    }
    button,
    input,
    select {
      font: inherit;
      padding: .35rem .6rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      text-align: start;
      padding: .5rem;
      border-bottom: 1px solid #ccc;
      overflow-wrap: anywhere;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 32rem;
      overflow: auto;
      padding: 1rem;
      background: #8881;
    }
    small {
      display: block;
      overflow-wrap: anywhere;
    }
    [role=alert] {
      color: #b22;
    }
  `;

  #value?: ArchiveCell;
  #unsubscribe?: () => void;
  #desired?: Selection;
  #pinned?: Pinned;
  #dirty = false;
  #busy = false;
  #work: Promise<void> = Promise.resolve();
  #abort?: AbortController;
  #records: ArchiveRecord[] = [];
  #selected?: ArchiveRecord;
  #pages: ArchivePage[] = [];
  #page?: ArchivePage;
  #text = "";
  #download?: string;
  #source = "";
  #key = "";
  #legacyId = "";
  #legacy = "";
  #error = "";

  get value(): ArchiveCell | undefined {
    return this.#value;
  }
  set value(value: ArchiveCell | undefined) {
    if (value === this.#value) return;
    this.#value = value;
    this.#subscribe();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#subscribe();
  }
  override disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#request(undefined);
    super.disconnectedCallback();
  }

  /** Exposes completion of component work for event-driven verification. */
  get accessForTestingOnly(): { idle: Promise<void> } {
    return {
      idle: (async () => {
        let work: Promise<void>;
        do {
          work = this.#work;
          await work;
        } while (work !== this.#work);
      })(),
    };
  }

  #subscribe(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#request(undefined);
    const cell = this.#value;
    if (!this.isConnected || !cell) return;
    this.#unsubscribe = cell.subscribe((catalog) => {
      if (
        !catalog || catalog.schema !== "commonfabric.agent-connector.catalog.v2"
      ) {
        this.#request(undefined);
        return;
      }
      if (
        this.#desired?.cell === cell &&
        this.#desired.catalog.generation === catalog.generation
      ) return;
      this.#request({ cell, catalog });
    });
  }

  #request(selection: Selection | undefined): void {
    this.#desired = selection;
    this.#dirty = true;
    this.#abort?.abort();
    if (!this.#busy) this.#start(() => this.#refresh());
  }

  #start(action: () => Promise<void>): void {
    if (this.#busy) return;
    this.#busy = true;
    this.#error = "";
    const abort = this.#abort = new AbortController();
    this.requestUpdate();
    this.#work = action().catch((error) => {
      if (!abort.signal.aborted) {
        this.#error = (error instanceof Error ? error.message : String(error))
          .slice(0, 1000);
      }
    }).finally(() => {
      this.#busy = false;
      this.requestUpdate();
      if (this.#dirty) this.#start(() => this.#refresh());
    });
  }

  #clearPage(): void {
    this.#page = undefined;
    this.#text = "";
    this.#legacy = "";
    if (this.#download) URL.revokeObjectURL(this.#download);
    this.#download = undefined;
  }

  async #refresh(): Promise<void> {
    this.#dirty = false;
    this.#records = [];
    this.#selected = undefined;
    this.#pages = [];
    this.#clearPage();
    const previous = this.#pinned;
    if (previous) {
      await previous.owner.close();
      this.#pinned = undefined;
    }
    const desired = this.#desired;
    if (!desired) return;
    const { archive, generation } = desired.catalog;
    const owner = new ArchivePinOwner(
      { archive, generation },
      (command, signal) => desired.cell.archive(command, signal),
    );
    this.#pinned = { ...desired, pin: owner.pin, owner };
    await owner.acquire(this.#abort?.signal);
    this.#abort?.signal.throwIfAborted();
    await this.#list();
  }

  #scope() {
    const pinned = this.#pinned;
    if (!pinned) throw new Error("Archive has no pinned generation");
    return {
      archive: pinned.catalog.archive,
      generation: pinned.catalog.generation,
      pin: pinned.pin,
    };
  }

  async #list(after?: string): Promise<void> {
    this.#selected = undefined;
    this.#pages = [];
    this.#clearPage();
    this.#records = (await this.#pinned!.cell.archive({
      op: "list",
      ...this.#scope(),
      ...(after ? { after } : {}),
      ...(this.#source ? { source: this.#source } : {}),
    }, this.#abort?.signal)).records ?? [];
  }

  async #select(record: ArchiveRecord): Promise<void> {
    this.#selected = record;
    await this.#directory();
  }

  async #directory(after?: number): Promise<void> {
    this.#clearPage();
    this.#pages = (await this.#pinned!.cell.archive({
      op: "pages",
      ...this.#scope(),
      key: this.#selected!.key,
      ...(after === undefined ? {} : { after }),
    }, this.#abort?.signal)).pages ?? [];
  }

  async #read(page: ArchivePage): Promise<void> {
    this.#clearPage();
    const bytes = await this.#pinned!.cell.archive({
      op: "read",
      ...this.#scope(),
      key: this.#selected!.key,
      index: page.index,
      hash: page.hash,
    }, this.#abort?.signal);
    this.#abort?.signal.throwIfAborted();
    this.#text = new TextDecoder().decode(bytes);
    this.#download = URL.createObjectURL(
      new Blob([bytes.slice()], { type: "application/octet-stream" }),
    );
    this.#page = page;
  }

  #selectCommand(record: ArchiveRecord): void {
    const metadata = JSON.parse(record.metadata) as ArchivedSession;
    if (metadata.schema === "commonfabric.agent-connector.session.v2") {
      this.emit("cf-select-session", {
        sourceId: metadata.sourceId,
        nativeSessionId: metadata.summary.nativeSessionId,
      });
    }
  }

  protected override render() {
    const catalog = this.#pinned?.catalog;
    const selected = this.#selected;
    return html`
      <p>${catalog
        ? `${catalog.sessionCount} sessions · ${catalog.checkoutCount} checkouts`
        : "Waiting for a published collection."}</p>
      ${this.#error ? html`<p role="alert">${this.#error}</p>` : nothing}
      <nav aria-label="Archive catalog">
        <button ?disabled=${this.#busy || !catalog} @click=${() =>
          this.#start(() => this.#list())}>First</button>
        <button ?disabled=${this.#busy ||
          this.#records.length === 0} @click=${() =>
          this.#start(() =>
            this.#list(this.#records.at(-1)?.key)
          )}>Next</button>
        <label>Source <select ?disabled=${this.#busy} @change=${(
          event: Event,
        ) => {
          this.#source = (event.target as HTMLSelectElement).value;
          this.#start(() => this.#list());
        }}>
          <option value="">All sources</option>
          ${catalog?.sources.map(({ source }) =>
            html`<option value=${source.id}>${source.id}</option>`
          )}
          <option value="@checkouts">Checkouts</option>
        </select></label>
        <label>Session key <input .value=${this.#key} @input=${(
          event: Event,
        ) => {
          this.#key = (event.target as HTMLInputElement).value.slice(0, 256);
        }}></label>
        <button ?disabled=${this.#busy || !catalog} @click=${() =>
          this.#start(async () => {
            const result = await this.#pinned!.cell.archive({
              op: "get",
              ...this.#scope(),
              key: this.#key,
            });
            const record = result.records?.[0];
            if (!record) {
              throw new Error("Session key was not found in this collection");
            }
            await this.#select(record);
          })}>Open</button>
        ${this.#busy ? html`<span role="status">Loading…</span>` : nothing}
      </nav>
      <details><summary>Inspect a legacy document</summary>
        <p>Inspection reads one bounded document. Linked documents remain addresses.</p>
        <label>Document ID <input .value=${this.#legacyId} @input=${(
          event: Event,
        ) => {
          this.#legacyId = (event.target as HTMLInputElement).value.slice(
            0,
            256,
          );
        }}></label>
        <button ?disabled=${this.#busy || !catalog} @click=${() =>
          this.#start(async () => {
            this.#clearPage();
            const result = await this.#pinned!.cell.archive({
              op: "legacy-read",
              archive: catalog!.archive,
              id: this.#legacyId,
            }, this.#abort?.signal);
            this.#legacy = result.legacy?.status === "available"
              ? result.legacy.wire!
              : result.legacy?.message ?? "Legacy document was not found.";
          })}>Inspect legacy document</button>
        ${this.#legacy ? html`<pre>${this.#legacy}</pre>` : nothing}
      </details>
      <table><thead><tr><th>Record</th><th>Source</th><th>Updated</th><th>Actions</th></tr></thead><tbody>
        ${this.#records.map((record) => {
          const metadata = JSON.parse(record.metadata) as
            | ArchivedSession
            | ArchivedCheckout
            | null;
          const session = metadata?.schema ===
              "commonfabric.agent-connector.session.v2"
            ? metadata
            : undefined;
          const title = metadata?.schema ===
              "commonfabric.agent-connector.checkout.v2"
            ? metadata.gitWorktreeRoot
            : session?.summary.title;
          return html`
            <tr>
              <td>${title ?? record.key}<small>${record
                .key}${record.partial
                ? " · Previous complete version"
                : ""}</small></td>
              <td>${record.source}</td>
              <td>${session?.summary.updatedAt ?? ""}</td>
              <td>
                        <button ?disabled=${this.#busy} @click=${() =>
                          this.#start(() =>
                            this.#select(record)
                          )}>Inspect</button>
                        ${metadata?.schema ===
                            "commonfabric.agent-connector.session.v2"
                          ? html`<button ?disabled=${this.#busy} @click=${() =>
                            this.#selectCommand(record)}>Command</button>`
                          : nothing}
                      </td>
            </tr>
          `;
        })}
      </tbody></table>
      ${selected
        ? html`
          <h3>${selected
            .key}</h3><details><summary>Session metadata</summary><pre>${JSON
            .stringify(JSON.parse(selected.metadata), null, 2)}</pre></details>
          <nav aria-label="Session page directory">
            <button ?disabled=${this.#busy} @click=${() =>
              this.#start(() => this.#directory())}>First pages</button>
            <button ?disabled=${this.#busy ||
              (this.#pages[0]?.index ?? 0) === 0} @click=${() =>
              this.#start(() =>
                this.#directory(
                  this.#pages[0].index <= 16
                    ? undefined
                    : this.#pages[0].index - 17,
                )
              )}>Previous pages</button>
            <button ?disabled=${this.#busy ||
              this.#pages.length === 0} @click=${() =>
              this.#start(() =>
                this.#directory(this.#pages.at(-1)?.index)
              )}>Next pages</button>
          </nav>
          ${this.#pages.map((page) =>
            html`
              <button ?disabled=${this.#busy}
                @click=${() =>
                  this.#start(() => this.#read(page))}>Page ${page.index +
                  1} · ${page.bytes} bytes</button>
            `
          )}
          ${this.#page
            ? html`<h4>Page ${
              this.#page.index + 1
            }</h4><small>SHA-256 ${this.#page.hash}</small><pre>${
              JSON.stringify(JSON.parse(this.#page.metadata), null, 2)
            }</pre><a href=${this
              .#download!} download=${`page-${this.#page.index}.bin`}>Download exact bytes</a><pre>${this.#text}</pre>`
            : nothing}
        `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-agent-archive": CFAgentArchive;
  }
}
