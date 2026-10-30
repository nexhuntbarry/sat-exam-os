import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** clsx + tailwind-merge, so a consumer's className overrides kit defaults. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
