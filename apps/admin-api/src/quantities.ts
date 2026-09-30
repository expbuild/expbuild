// Compare nonnegative Kubernetes quantities without floating point rounding.
// Bound input/exponents because observation data must not allocate unbounded BigInts.
function rational(value: string): [bigint, bigint] {
  if (typeof value !== "string" || value.length > 128)
    throw new Error("Invalid resource quantity");
  const match =
    /^([+]?(?:\d+(?:\.\d*)?|\.\d+))([eE][+-]?\d+|[numkMGTPE]|[KMGTPE]i)?$/.exec(
      value,
    );
  if (!match?.[1]) throw new Error("Invalid resource quantity");
  const [whole, fraction = ""] = match[1].replace(/^\+/, "").split(".");
  let numerator = BigInt((whole || "0") + fraction),
    denominator = 10n ** BigInt(fraction.length);
  const suffix = match[2] ?? "";
  const binary = ["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"].indexOf(suffix);
  if (binary >= 0) numerator *= 1024n ** BigInt(binary + 1);
  else {
    const powers: Record<string, number> = {
      "": 0,
      n: -9,
      u: -6,
      m: -3,
      k: 3,
      M: 6,
      G: 9,
      T: 12,
      P: 15,
      E: 18,
    };
    const exponent =
      /^[eE]/.test(suffix) && suffix.length > 1
        ? Number(suffix.slice(1))
        : powers[suffix];
    if (
      exponent === undefined ||
      !Number.isInteger(exponent) ||
      Math.abs(exponent) > 128
    )
      throw new Error("Invalid resource quantity");
    if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
    else denominator *= 10n ** BigInt(-exponent);
  }
  return [numerator, denominator];
}
export function quantityExceeds(actual: string, reserved: string): boolean {
  const [a, ad] = rational(actual),
    [r, rd] = rational(reserved);
  return a * rd > r * ad;
}

export function quantityCeil(actual: string, unit: string): number {
  const [a, ad] = rational(actual),
    [u, ud] = rational(unit);
  if (u <= 0n) throw new Error("Invalid resource unit");
  const numerator = a * ud,
    denominator = ad * u;
  const rounded = (numerator + denominator - 1n) / denominator;
  // The public quota schema and admission totals use bounded JS numbers.
  if (rounded > 2147483647n) throw new Error("Resource quantity exceeds platform limit");
  return Number(rounded);
}
