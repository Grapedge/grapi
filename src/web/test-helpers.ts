import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function fakeTheme(): {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
} {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

export const FAKE_CTX = {
  mode: "print",
  hasUI: false,
  isProjectTrusted: () => true,
} as ExtensionContext;
