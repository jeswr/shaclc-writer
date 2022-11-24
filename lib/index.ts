import { Quad, NamedNode } from '@rdfjs/types';
import ShaclcGenerator from './ShaclcGenerator';
import Writer from './writer';
import VolitileStore from './volatile-store';

export interface Options {
  prefixes?: { [prefix: string]: string | NamedNode; };
  errorOnUnused?: boolean;
}

export interface Result {
  text: string;
  extraQuads?: Quad[];
}

export async function write(quads: Quad[], options?: Options): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    try {
      let s = '';
      const volatileStore = new VolitileStore(quads);
      const w = new Writer({
        write: (chunk: string) => {
          s += chunk;
        },
        end: () => {
          let extraQuads: Quad[] | undefined = volatileStore.getQuads(null, null, null, null);

          if (extraQuads.length === 0) {
            extraQuads = undefined;
          }

          resolve({
            text: s,
            extraQuads,
          });
        },
      });
      const writer = new ShaclcGenerator(
        volatileStore,
        w,
        options?.prefixes,
        undefined,
        options?.errorOnUnused !== false,
      );
      writer.write();
    } catch (e) {
      reject(e);
    }
  });
}
