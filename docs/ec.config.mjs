import { defineEcConfig } from "@astrojs/starlight/expressive-code";
import splxGrammarJson from "../editors/vscode/syntaxes/splx.tmLanguage.json" with { type: "json" };
import { pluginEditorFrame } from "./src/ec-editor-frame.mjs";

const splxGrammar = {
  ...splxGrammarJson,
  name: "splx",
  aliases: ["spl"],
};

export default defineEcConfig({
  themes: ["vitesse-black", "github-light"],
  plugins: [pluginEditorFrame()],
  styleOverrides: {
    borderRadius: "0.3rem",
    borderColor: "var(--spl-code-border)",
    codeFontFamily: "var(--sl-font-mono)",
    uiFontFamily: "var(--sl-font-mono)",
    frames: {
      frameBoxShadowCssValue: "none",
      editorBackground: "var(--spl-code-bg)",
      terminalBackground: "var(--spl-code-bg)",
      editorTabBarBackground: "var(--spl-code-chrome)",
      terminalTitlebarBackground: "var(--spl-code-chrome)",
      editorActiveTabBackground: "var(--spl-code-bg)",
      editorActiveTabIndicatorTopColor: "var(--sl-color-accent)",
    },
  },
  shiki: {
    langs: [splxGrammar],
  },
});
