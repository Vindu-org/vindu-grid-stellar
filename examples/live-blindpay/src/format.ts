/** Small formatting helpers for the printed lines. */
import type { Money } from '@vindu/grid-core';

/** `9972 USD`. */
export function fmt(value: Money): string {
  return `${value.amount} ${value.asset.code}`;
}

/** A Stellar address or hash, shortened for display: `GABC...WXYZ`. */
export function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 4)}...${value.slice(-4)}`;
}
