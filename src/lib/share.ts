import type { MediaType } from "./tmdb";

export const shareHost = "https://kinuza.channeluza.com";

export function shareLink(type: MediaType, id: number): string {
  return `${shareHost}/t/${type}/${id}`;
}
