// @ts-check
// `@type` JSDoc annotations allow editor autocompletion and type checking
// (when paired with `@ts-check`).
// There are various equivalent ways to declare your Docusaurus config.
// See: https://docusaurus.io/docs/api/docusaurus-config

import { themes as prismThemes } from "prism-react-renderer";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Tutor Management System",
  tagline: "Documentation for the Tutor Management System",
  favicon: "img/favicon.ico",

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // TODO: after your first successful GitLab Pages deploy, GitLab shows the
  // live URL under Deploy > Pages in the project sidebar. Put that exact
  // URL here, and set baseUrl to match its path (often '/<projectName>/').
  url: "https://the-devden.pages.sdp.ms.wits.ac.za",
  baseUrl: "/Tutor-Management-System/",

  organizationName: "the-devden",
  projectName: "Tutor-Management-System",

  onBrokenLinks: "throw",

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: "./sidebars.js",
          editUrl:
            "https://sdp.ms.wits.ac.za/the-devden/Tutor-Management-System/-/tree/main/my-docs/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      // Replace with your project's social card
      image: "img/docusaurus-social-card.jpg",
      colorMode: {
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: "Tutor Management System",
        logo: {
          alt: "Tutor Management System Logo",
          src: "img/logo.svg",
        },
        items: [
          {
            type: "docSidebar",
            sidebarId: "tutorialSidebar",
            position: "left",
            label: "Docs",
          },
          {
            href: "https://sdp.ms.wits.ac.za/the-devden/Tutor-Management-System",
            label: "Repository",
            position: "right",
          },
        ],
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "Docs",
            items: [
              {
                label: "Introduction",
                to: "/docs/intro",
              },
              {
                label: "Getting Started",
                to: "/docs/getting-started",
              },
              {
                label: "Dev Plan",
                to: "/docs/dev-plan",
              },
            ],
          },
          {
            title: "More",
            items: [
              {
                label: "Repository",
                href: "https://sdp.ms.wits.ac.za/the-devden/Tutor-Management-System",
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Tutor Management System. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
      },
    }),
};

export default config;
