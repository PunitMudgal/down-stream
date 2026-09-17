declare module "m3u8-parser" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m3u8Parser: any;
  export default m3u8Parser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Parser: any;
}

declare module "mpd-parser" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function parse(mpd: string, options?: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def: any;
  export default def;
}
