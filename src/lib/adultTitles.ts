const adult = new Set<string>();

export function markAdult(type: string, id: number): void {
  adult.add(`${type}:${id}`);
}

export function isAdultTitle(type: string, id: number): boolean {
  return adult.has(`${type}:${id}`);
}
