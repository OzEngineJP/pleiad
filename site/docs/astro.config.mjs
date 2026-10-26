// 公開リファレンス（https://pleiad.dev/docs/）。日本語を根に、英語を /docs/en/ の下に置く（Starlight の i18n）。
// 組むのは site/tools/build-site.mjs（Cloudflare のビルドコマンドから呼ばれる）。site/docs で npm run dev でも見られる。
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://pleiad.dev",
  base: "/docs",
  integrations: [
    starlight({
      title: "Pleiad",
      description: "Pleiad の使い方",
      defaultLocale: "root",
      locales: {
        root: { label: "日本語", lang: "ja" },
        en: { label: "English", lang: "en" },
      },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/docs.css"],
      credits: false,
      sidebar: [
        {
          label: "はじめに",
          translations: { en: "Getting started" },
          items: [{ label: "はじめに", translations: { en: "Getting started" }, slug: "getting-started" }],
        },
        {
          label: "エージェント",
          translations: { en: "Agents" },
          items: [{ autogenerate: { directory: "agents" } }],
        },
        {
          label: "リファレンス",
          translations: { en: "Reference" },
          items: [{ autogenerate: { directory: "reference" } }],
        },
        {
          label: "困ったとき",
          translations: { en: "Troubleshooting" },
          items: [{ label: "困ったとき", translations: { en: "Troubleshooting" }, slug: "troubleshooting" }],
        },
      ],
    }),
  ],
});
