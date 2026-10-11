const MAX_DEPTH = 32;

class Reader {
  pos = 0;
  bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte() {
    if (this.pos >= this.bytes.length) throw new RangeError("footer ends early");
    return this.bytes[this.pos++];
  }

  varint() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
    }
    throw new RangeError("varint too long");
  }

  zigzag() {
    const value = this.varint();
    return (value >> 1n) ^ -(value & 1n);
  }

  take(length: number) {
    if (length < 0 || this.pos + length > this.bytes.length) throw new RangeError("footer ends early");
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  skip(type: number, inCollection: boolean, depth: number) {
    if (depth > MAX_DEPTH) throw new RangeError("footer nests too deeply");
    switch (type) {
      case 1:
      case 2:
        if (inCollection) this.byte();
        return;
      case 3:
        this.byte();
        return;
      case 4:
      case 5:
      case 6:
        this.varint();
        return;
      case 7:
        this.take(8);
        return;
      case 8:
        this.take(Number(this.varint()));
        return;
      case 9:
      case 10: {
        const [size, element] = this.listHeader();
        for (let i = 0; i < size; i++) this.skip(element, true, depth + 1);
        return;
      }
      case 11: {
        const size = Number(this.varint());
        if (!size) return;
        const types = this.byte();
        for (let i = 0; i < size; i++) {
          this.skip(types >> 4, true, depth + 1);
          this.skip(types & 0x0f, true, depth + 1);
        }
        return;
      }
      case 12:
        this.struct(depth + 1, () => false);
        return;
    }
    throw new RangeError("unknown footer type");
  }

  listHeader(): [number, number] {
    const header = this.byte();
    const size = header >> 4 === 15 ? Number(this.varint()) : header >> 4;
    return [size, header & 0x0f];
  }

  struct(depth: number, onField: (id: number, type: number) => boolean) {
    let id = 0;
    for (;;) {
      const header = this.byte();
      if (header === 0) return;
      const type = header & 0x0f;
      id = header >> 4 ? id + (header >> 4) : Number(this.zigzag());
      if (!onField(id, type)) this.skip(type, false, depth);
    }
  }
}

interface SchemaElement {
  name: string;
  children: number;
}

function schemaElement(reader: Reader): SchemaElement {
  const element = { name: "", children: 0 };
  reader.struct(2, (id, type) => {
    if (id === 4 && type === 8) element.name = new TextDecoder().decode(reader.take(Number(reader.varint())));
    else if (id === 5 && type === 5) element.children = Number(reader.zigzag());
    else return false;
    return true;
  });
  return element;
}

export interface ParquetFooter {
  rows: number;
  columns: string[];
}

export function readParquetFooter(bytes: Uint8Array): ParquetFooter {
  const reader = new Reader(bytes);
  const elements: SchemaElement[] = [];
  let rows: bigint | null = null;
  reader.struct(1, (id, type) => {
    if (id === 2 && type === 9) {
      const [size] = reader.listHeader();
      for (let i = 0; i < size; i++) elements.push(schemaElement(reader));
    } else if (id === 3 && type === 6) rows = reader.zigzag();
    else return false;
    return true;
  });
  if (rows === null || rows < 0n || rows > BigInt(Number.MAX_SAFE_INTEGER) || !elements.length) throw new RangeError("footer lacks rows or schema");
  const columns: string[] = [];
  let index = 1;
  for (let remaining = elements[0].children; remaining > 0 && index < elements.length; remaining--) {
    columns.push(elements[index].name);
    let outstanding = elements[index++].children;
    while (outstanding > 0 && index < elements.length) outstanding += elements[index++].children - 1;
  }
  return { rows: Number(rows), columns };
}
