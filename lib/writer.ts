/* eslint-disable no-unused-vars */
type writeFunc = (chunk: string, encoding: string, done?: Function) => void;

/**
 * Convenience class used to write chunks
 */
export default class Writer {
  private indents = 0;

  private write: writeFunc

  private end: (done?: Function) => void;

  constructor(options: { write: writeFunc, end: (done?: Function) => void }) {
    this.write = options.write;
    this.end = options.end;
  }

  indent() {
    // eslint-disable-next-line no-plusplus
    this.indents++;
    return this;
  }

  deindent() {
    if (this.indents < 1) {
      throw new Error(`Trying to deindent when indent is only ${this.indents}`);
    }
    // eslint-disable-next-line no-plusplus
    this.indents--;
    return this;
  }

  add(s: string, newLine = false) {
    this.write(newLine ? `\n${'\t'.repeat(this.indents)}` : '', 'utf-8');
    return this;
  }

  newLine(no: number = 2) {
    this.write('\n'.repeat(no) + '\t'.repeat(this.indents), 'utf-8');
    return this;
  }
}
