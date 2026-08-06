export class RingBuffer<T> {
  private items: T[] = [];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {}

  push(item: T): void {
    if (this.capacity <= 0) return;
    if (this.count >= this.capacity) {
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.items[this.count] = item;
      this.count += 1;
    }
  }

  get size(): number {
    return this.count;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let index = 0; index < this.count; index += 1) {
      out.push(this.items[(this.head + index) % this.capacity]);
    }
    return out;
  }
}
