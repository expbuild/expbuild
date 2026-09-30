import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const status = z.object({
  CurrSize: count,
  MaxSize: count.positive(),
  NumFiles: count,
  ReservedSize: count.optional(),
  UncompressedSize: count.optional(),
});
export type InstanceStatistics = {
  observedAt: string;
  source: "bazel-remote-status";
  usedBytes: number;
  capacityBytes: number;
  itemCount: number;
  reservedBytes: number | null;
  uncompressedBytes: number | null;
};

// Address components come from the owned CR, never from status endpoint URLs.
export async function readEngineStatistics(
  namespace: string,
  name: string,
  username: string,
  password: string,
  fetcher: typeof fetch = fetch,
): Promise<InstanceStatistics> {
  const dns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!dns.test(namespace) || !dns.test(name) || !username || !password)
    throw new Error("Invalid statistics target");
  const response = await fetcher(
    `http://${name}.${namespace}.svc:8080/status`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Engine statistics unavailable");
  }
  if (!response.body) throw new Error("Empty engine statistics");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 65536)
        throw new Error("Engine statistics response too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const data = status.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  return {
    observedAt: new Date().toISOString(),
    source: "bazel-remote-status",
    usedBytes: data.CurrSize,
    capacityBytes: data.MaxSize,
    itemCount: data.NumFiles,
    reservedBytes: data.ReservedSize ?? null,
    uncompressedBytes: data.UncompressedSize ?? null,
  };
}
