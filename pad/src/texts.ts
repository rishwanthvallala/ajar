/**
 * The pad's text files: each one its text, until something needs it as an
 * editor model.
 *
 * Every file used to have a Monaco model from the moment the pad opened — 500
 * for a pad of 500 files, each listening to the language service, which
 * Monaco reports past 200 as a listener leak. A model is wanted only where the
 * editor is: the file on screen, one a run marked a problem in, one an edit
 * goes into as typing would. The rest is text, read by what saves, seeds,
 * runs, moves and downloads files, which never needed a model to do it.
 *
 * Text kept as text is also kept exactly. A model converts mixed line endings
 * to one and sets a byte-order mark aside, and that converted text was what
 * the sandbox was given of a file nobody had opened, and what the first
 * command saved of it, for everyone (18 October).
 *
 * Generic over the model so that `check.ts` can hold it to all of this with
 * stand-ins.
 */

/** What reading a file needs, from its model or from its text. */
export interface Readable {
  getValue(): string;
  getValueLength(): number;
}

/** A file without a model. */
class Plain implements Readable {
  constructor(public text: string) {}

  getValue(): string {
    return this.text;
  }

  getValueLength(): number {
    return this.text.length;
  }
}

export class Texts<M extends Readable & { dispose(): void }> {
  /** In the order the files arrived, which making a model keeps. */
  private readonly held = new Map<string, M | Plain>();

  /** `make` turns a file's text into its model, once. */
  constructor(private readonly make: (path: string, text: string) => M) {}

  get size(): number {
    return this.held.size;
  }

  has(path: string): boolean {
    return this.held.has(path);
  }

  keys(): IterableIterator<string> {
    return this.held.keys();
  }

  /** Each file to read, as `seedFiles` takes them. */
  [Symbol.iterator](): IterableIterator<[string, Readable]> {
    return this.held.entries();
  }

  /** The file to read: its model, if it has one. Never makes one. */
  get(path: string): Readable | undefined {
    return this.held.get(path);
  }

  /** Its model, if it has one already. */
  existing(path: string): M | undefined {
    const held = this.held.get(path);
    return held instanceof Plain ? undefined : held;
  }

  /** Its model, made now from its text if it has none; nothing for a path the pad does not have. */
  model(path: string): M | undefined {
    const held = this.held.get(path);
    if (!(held instanceof Plain)) return held;
    const model = this.make(path, held.text);
    this.held.set(path, model);
    return model;
  }

  /** The models made so far. */
  *models(): IterableIterator<[string, M]> {
    for (const [path, held] of this.held) if (!(held instanceof Plain)) yield [path, held];
  }

  /**
   * A new file's text, or new text for one without a model: whether that
   * changed anything. One with a model changes through it, as typing does.
   */
  put(path: string, text: string): boolean {
    const held = this.held.get(path);
    if (held === undefined) {
      this.held.set(path, new Plain(text));
      return true;
    }
    if (!(held instanceof Plain)) throw new Error(`${path} has a model: change it there`);
    if (held.text === text) return false;
    held.text = text;
    return true;
  }

  /** A file gone, and its model with it. */
  delete(path: string): void {
    const held = this.held.get(path);
    if (held && !(held instanceof Plain)) held.dispose();
    this.held.delete(path);
  }

  clear(): void {
    for (const path of [...this.held.keys()]) this.delete(path);
  }
}
