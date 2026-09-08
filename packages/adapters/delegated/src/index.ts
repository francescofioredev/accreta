import {
  DelegatedSourceError,
  formatCitation,
  UNPINNED_REVISION,
  type LocationVerdict,
  type SourceAdapter,
} from "@accreta/core";

export interface DelegatedSourceOptions {
  id: string;
  /**
   * The connector the agent needs in order to read this source.
   *
   * A free-form name — `notion`, `gmail`, whatever the agent's own
   * configuration calls it. accreta never interprets it, which is why one
   * adapter covers every such source instead of one package per provider.
   */
  via: string;
  /**
   * What is in scope, in prose, for the agent to read.
   *
   * The only definition there is. accreta cannot enumerate this source, so it
   * cannot narrow what the agent looks at either — the declaration says it and
   * the agent honours it.
   */
  scope: string;
  /** Provenance template, from `accreta.config.yaml`. */
  citationFormat: string;
}

/**
 * A source accreta cannot reach, and does not try to.
 *
 * The corpora that need this are the ones behind a connector: a wiki, a
 * mailbox, a tracker. The obvious adapter holds a credential and calls the
 * provider's API. This one holds nothing and calls nobody. Its job is to say
 * precisely what the agent has to go and check, and to keep the pages citing it
 * out of every outcome that would imply somebody had checked them.
 *
 * That leaves it able to answer half the interface. Rendering a citation is
 * string formatting and works exactly as it does anywhere else, so provenance
 * into a delegated source is as good as provenance into a repository. What it
 * cannot do is answer questions about the source itself, and it raises rather
 * than invents.
 *
 * The cost, stated because it cannot be mitigated: a citation into this source
 * is never checked. An invented page id and a real one are indistinguishable
 * here. `lint` counts them as unchecked rather than passing them as verified.
 */
export class DelegatedSource implements SourceAdapter {
  readonly id: string;
  private readonly via: string;
  private readonly scope: string;
  private readonly citationFormat: string;

  constructor(options: DelegatedSourceOptions) {
    // Refused at construction rather than defaulted. A delegated source whose
    // scope is empty tells the agent to check "the connector", which is either
    // nothing or everything, and both are worse than a startup error naming the
    // file to fix.
    if (!options.via.trim()) {
      throw new Error(`Source "${options.id}" is delegated but declares no \`via\`.`);
    }
    if (!options.scope.trim()) {
      throw new Error(
        `Source "${options.id}" is delegated but declares no \`scope\`. ` +
          `Scope is prose the agent reads, and nothing else says what it may look at.`,
      );
    }

    this.id = options.id;
    this.via = options.via;
    this.scope = options.scope;
    this.citationFormat = options.citationFormat;
  }

  async revision(): Promise<string> {
    throw this.delegate();
  }

  async changedSince(_revision: string): Promise<string[]> {
    throw this.delegate();
  }

  /**
   * Never `missing`: this source has no way to know, and saying a citation is
   * broken because nobody looked would be worse than saying nothing.
   */
  async locate(_path: string, _locator?: string): Promise<LocationVerdict> {
    return {
      verdict: "unknown",
      detail: `source "${this.id}" is read through ${this.via}; accreta cannot check it`,
    };
  }

  citation(path: string, locator?: string): string {
    return formatCitation(this.citationFormat, {
      source: this.id,
      rev: this.pinnedRevision ?? UNPINNED_REVISION,
      path,
      locator,
    });
  }

  private pinnedRevision: string | undefined;

  pinRevision(revision: string): void {
    this.pinnedRevision = revision;
  }

  private delegate(): DelegatedSourceError {
    return new DelegatedSourceError(this.id, this.via, this.scope);
  }
}
