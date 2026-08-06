export class RingBuffer<T> {
  private items: T[] = [];

  constructor(private capacity: number) {}

  push(item: T): void {
    if (this.items.length === this.capacity) this.items.shift();
    this.items.push(item);
  }

  get size(): number {
    return this.items.length;
  }

  toArray(): T[] {
    return [...this.items];
  }
}
