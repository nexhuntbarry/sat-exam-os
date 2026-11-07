declare module "pagedjs" {
  export class Previewer {
    constructor(options?: Record<string, unknown>);
    preview(
      content?: Node | DocumentFragment | string,
      stylesheets?: (string | Record<string, string>)[],
      renderTo?: HTMLElement,
    ): Promise<{ total: number; pages: unknown[] }>;
    on(event: "page" | "rendered", cb: (...args: unknown[]) => void): void;
  }
}

declare module "*/pagedjs/dist/paged.esm.js" {
  export { Previewer } from "pagedjs";
}
