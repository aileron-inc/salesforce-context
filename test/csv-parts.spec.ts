import { describe, expect, it } from "vitest";

import { splitCsvBytes } from "../src/csv-parts";

describe("splitCsvBytes", () => {
  it("上限未満の CSV は1パートのままバイト列を保つ", async () => {
    const csv = text([
      "Id,Name",
      'record-1,"1行目\n2行目"',
      'record-2,"カンマ, と引用符""あり"',
    ]);

    const parts = await splitCsvBytes(csv, 1024, 1);
    expect(parts).toHaveLength(1);
    expect(decode(parts[0])).toBe(decode(csv));
  });

  it("引用符内の改行を割らず、各パートにヘッダを繰り返す", async () => {
    const header = "Id,Name\n";
    const row1 = '"aaa\nbbb",1\n';
    const row2 = "ccc,2\n";
    const row3 = "ddd,3";
    const raw = new TextEncoder().encode(`${header}${row1}${row2}${row3}`);
    const maxBytes = new TextEncoder().encode(header + row1).byteLength;

    const parts = await splitCsvBytes(raw, maxBytes, 3);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => decode(part).startsWith("Id,Name\n"))).toBe(true);
    expect(parts.some((part) => decode(part).includes('"aaa\nbbb",1'))).toBe(true);
    expect(parts.every((part) => part.byteLength <= maxBytes || decode(part).includes('"aaa\nbbb",1'))).toBe(true);

    const rows = parts.flatMap((part) => {
      const body = decode(part).slice("Id,Name\n".length);
      return body.length === 0 ? [] : [body];
    });
    expect(rows.join("")).toBe(`${row1}${row2}${row3}`);
  });

  it("1レコードが上限を超えてもレコードの途中では分割しない", async () => {
    const raw = new TextEncoder().encode('Id\n"abcdef"\n');
    const parts = await splitCsvBytes(raw, 4, 2);
    expect(parts).toHaveLength(1);
    expect(decode(parts[0])).toBe('Id\n"abcdef"\n');
  });

  it("空の結果は空の1パートになる", async () => {
    const parts = await splitCsvBytes(new Uint8Array(0), 32);
    expect(parts).toEqual([new Uint8Array(0)]);
  });
});

function text(value: string | string[]): Uint8Array {
  const source = Array.isArray(value) ? value.join("\n") : value;
  return new TextEncoder().encode(source);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
