import clsx from "clsx";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import HomepageFeatures from "@site/src/components/HomepageFeatures";

import styles from "./index.module.css";

function TutorXMark({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 120 120"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Pale sky echo behind the mark */}
      <line
        className={styles.markEcho}
        x1="34"
        y1="34"
        x2="94"
        y2="94"
        strokeWidth="15"
        strokeLinecap="round"
      />
      <line
        className={styles.markEcho}
        x1="94"
        y1="34"
        x2="70"
        y2="58"
        strokeWidth="15"
        strokeLinecap="round"
      />
      <line
        className={styles.markEcho}
        x1="58"
        y1="70"
        x2="34"
        y2="94"
        strokeWidth="15"
        strokeLinecap="round"
      />
      {/* Main strokes: deep blue diagonal, azure breaks */}
      <line
        className={styles.markNavy}
        x1="26"
        y1="26"
        x2="86"
        y2="86"
        strokeWidth="15"
        strokeLinecap="round"
      />
      <line
        className={styles.markAccent}
        x1="86"
        y1="26"
        x2="62"
        y2="50"
        strokeWidth="15"
        strokeLinecap="round"
      />
      <line
        className={styles.markAccent}
        x1="50"
        y1="62"
        x2="26"
        y2="86"
        strokeWidth="15"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HomepageHero() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={styles.heroBanner}>
      <div className="container">
        <div className={styles.heroPanel}>
          <div className={styles.lockup}>
            <TutorXMark className={styles.heroMark} />
            <h1 className={styles.heroTitle}>
              Tutor<span className={styles.heroTitleAccent}>X</span>
            </h1>
          </div>
          <p className={styles.heroTagline}>{siteConfig.tagline}</p>
          <div className={styles.heroButtons}>
            <Link
              className={clsx(
                "button button--primary button--lg",
                styles.heroCta,
              )}
              to="/docs/intro"
            >
              Read the Docs
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="Documentation for the Tutor Management System"
    >
      <HomepageHero />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
