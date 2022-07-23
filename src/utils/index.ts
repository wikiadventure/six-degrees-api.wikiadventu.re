import type { PathLike } from "fs";
import { access } from "fs/promises";

export async function exists(path:PathLike) {  
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }


declare global {
    interface Array<T> {
        remove(x:T): void;
        popRandom():T | undefined;
    }
}

Array.prototype.remove = function (x) {
    const i = this.indexOf(x);
    return i > -1 && this.splice(i,1);
}
