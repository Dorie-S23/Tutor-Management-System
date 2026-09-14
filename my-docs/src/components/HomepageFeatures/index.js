import Heading from "@theme/Heading";
import styles from "./styles.module.css";

const FeatureList = [
  {
    title: "Allocation Board",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect
          className={styles.iconStroke}
          x="3"
          y="3"
          width="18"
          height="18"
          rx="3"
        />
        <line className={styles.iconStroke} x1="9" y1="3" x2="9" y2="21" />
        <line className={styles.iconAccent} x1="15" y1="3" x2="15" y2="21" />
      </svg>
    ),
    description: (
      <>
        Track which courses need tutors and match tutors against courses from a
        single board, with clashes in marks, timetable, and hours remaining
        flagged automatically.
      </>
    ),
  },
  {
    title: "Express + Supabase",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect
          className={styles.iconStroke}
          x="3"
          y="4"
          width="18"
          height="6"
          rx="2"
        />
        <rect
          className={styles.iconStroke}
          x="3"
          y="14"
          width="18"
          height="6"
          rx="2"
        />
        <line className={styles.iconAccent} x1="7" y1="7" x2="7" y2="7.01" />
        <line className={styles.iconAccent} x1="7" y1="17" x2="7" y2="17.01" />
      </svg>
    ),
    description: (
      <>
        An Express 5 server serves the frontend and exposes a REST API backed by
        a hosted Supabase Postgres database.
      </>
    ),
  },
  {
    title: "No Framework Frontend",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline className={styles.iconStroke} points="8 6 3 12 8 18" />
        <polyline className={styles.iconStroke} points="16 6 21 12 16 18" />
        <line
          className={styles.iconAccent}
          x1="10.5"
          y1="9"
          x2="13.5"
          y2="15"
        />
        <line
          className={styles.iconAccent}
          x1="13.5"
          y1="9"
          x2="10.5"
          y2="15"
        />
      </svg>
    ),
    description: (
      <>
        The board UI is vanilla HTML, CSS, and JS, served directly by Express —
        no build step required.
      </>
    ),
  },
];

function Feature({ title, icon, description }) {
  return (
    <div className="col col--4">
      <div className={styles.featureCard}>
        <div className={styles.featureIcon}>{icon}</div>
        <Heading as="h3" className={styles.featureTitle}>
          {title}
        </Heading>
        <p className={styles.featureDescription}>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
